/** A tab-local safety gate. Never queues or replays requests during renewal. */
import { useSyncExternalStore } from 'react';
import { withBasePath } from '@/base-path';
import type { PlatformSession } from './platform-session';

let paused = false;
let generation = 0;
let owner: string | null = null;
let verifiedAt = 0;
const listeners = new Set<() => void>();

export function sessionOwner(session: PlatformSession): string {
  return JSON.stringify([
    session.kind,
    session.personId,
    session.subject,
    session.role,
    session.impersonation?.sessionId,
  ]);
}

export const isSessionPaused = () => paused;
export function pauseSession() {
  if (paused) return;
  paused = true;
  generation++;
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event('codex-webui:session-paused'));
}

/** Only a fresh server response for the original identity may reopen this tab. */
export function acceptVerifiedSession(session: PlatformSession): boolean {
  const nextOwner = sessionOwner(session);
  if (!session.active || (owner !== null && owner !== nextOwner)) {
    pauseSession();
    return false;
  }
  owner = nextOwner;
  verifiedAt = Date.now();
  paused = false;
  for (const listener of listeners) listener();
  return true;
}

export function useSessionPaused() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, isSessionPaused);
}

const renewalEndpoints = new Map(
  [
    ['me', 'GET'],
    ['methods', 'GET'],
    ['login', 'POST'],
    ['local-login', 'POST'],
  ].map(([path, method]) => [withBasePath(`/api/auth/${path}`), method]),
);

/** Install before React/socket/focus recovery can start protected requests. */
export function installSessionRecovery() {
  pauseSession();
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    );
    const apiRequest =
      url.origin === window.location.origin &&
      url.pathname.startsWith(withBasePath('/api/'));
    if (!apiRequest) return originalFetch(input, init);
    const renewalRequest =
      renewalEndpoints.get(url.pathname) ===
      (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
    if (renewalRequest)
      return originalFetch(input, { ...init, redirect: 'manual' });
    const aborted = () =>
      new DOMException('Session verification required', 'AbortError');
    if (paused) throw aborted();
    const startedIn = generation;
    // Do not forward API credentials to an external login redirect.
    const response = await originalFetch(input, {
      ...init,
      redirect: 'manual',
    });
    if (
      response.status === 401 ||
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    ) {
      pauseSession();
      window.dispatchEvent(new Event('codex-webui:auth-expired'));
      throw aborted();
    }
    // An old response must not refresh a view after identity verification failed.
    if (startedIn !== generation) throw aborted();
    return response;
  };
  const wake = () => {
    if (
      document.visibilityState === 'visible' &&
      owner !== null &&
      Date.now() - verifiedAt >= 30_000
    )
      pauseSession();
  };
  const expired = () => pauseSession();
  for (const name of ['focus', 'pageshow', 'online'])
    window.addEventListener(name, wake, true);
  document.addEventListener('visibilitychange', wake, true);
  window.addEventListener('codex-webui:auth-expired', expired, true);
  return () => {
    window.fetch = originalFetch;
    for (const name of ['focus', 'pageshow', 'online'])
      window.removeEventListener(name, wake, true);
    document.removeEventListener('visibilitychange', wake, true);
    window.removeEventListener('codex-webui:auth-expired', expired, true);
    owner = null;
    verifiedAt = 0;
    paused = false;
  };
}
