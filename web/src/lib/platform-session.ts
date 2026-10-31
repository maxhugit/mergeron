import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { clearApiToken, getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import {
  acceptVerifiedSession,
  hasVerifiedSession,
  pauseSession,
  sessionVerificationGeneration,
  useSessionPaused,
} from './session-recovery';

export interface PlatformSession {
  kind: 'person' | 'service' | 'unlinked';
  personId: string | null;
  name: string | null;
  role: 'standard' | 'administrator' | null;
  active: boolean;
  subject?: string;
  email?: string;
  theme?: string;
  language?: string;
  impersonation?: {
    sessionId: string;
    administratorId: string;
    administratorName: string;
    personId: string;
    personName: string;
    expiresAt: number;
    expired?: boolean;
  };
}

const SESSION_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
export const AUTH_REQUEST_TIMEOUT_MS = 12_000;
export const SESSION_RECOVERY_INTERVAL_MS = 5_000;

export class AuthResourceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthResourceError';
    this.status = status;
  }
}

/** A proxy login redirect needs a browser navigation, not an XHR to the IdP. */
export class AuthRedirectError extends AuthResourceError {
  constructor() {
    super('Authentication requires browser navigation', 401);
    this.name = 'AuthRedirectError';
  }
}

export function isSessionTransportError(error: Error | null): boolean {
  return (
    error !== null &&
    (!(error instanceof AuthResourceError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500)
  );
}

export class AuthIdentityChangedError extends AuthResourceError {
  constructor() {
    super('Sign in with the original identity to resume this tab', 409);
    this.name = 'AuthIdentityChangedError';
  }
}

export function shouldRetryPlatformSession(
  failureCount: number,
  error: Error,
  previouslyVerified = false,
): boolean {
  if (failureCount >= SESSION_RETRY_DELAYS_MS.length) return false;
  // A proxy can briefly ask for login while its session store restarts. Recheck
  // only the identity GET, with the gate closed, before asking the user to log
  // in again. Never retry a backend 401/403, accept cache, or replay a mutation.
  if (error instanceof AuthRedirectError) return previouslyVerified;
  if (error instanceof AuthResourceError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return true;
}
export async function updateAuthResource<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/auth/${path}`), {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Unable to save profile preferences');
  return response.json() as Promise<T>;
}
export const platformSessionKey = ['platform-session'] as const;
export async function readAuthResource<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = window.setTimeout(
    () =>
      controller.abort(
        new DOMException('Identity verification timed out', 'TimeoutError'),
      ),
    AUTH_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(withBasePath(`/api/auth/${path}`), {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
      headers: authorization ? { Authorization: authorization } : {},
    });
    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    )
      throw new AuthRedirectError();
    if (!response.ok)
      throw new AuthResourceError(
        'Unable to verify your identity',
        response.status,
      );
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('Identity endpoint did not return JSON');
    // Await the body before clearing the deadline (a resumed connection may hang here too).
    return (await response.json()) as T;
  } catch (error) {
    if (!(error instanceof AuthResourceError) && !signal?.aborted)
      window.dispatchEvent(new Event('codex-webui:transport-recover'));
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
export function usePlatformSession() {
  const paused = useSessionPaused();
  const query = useQuery({
    queryKey: platformSessionKey,
    queryFn: async ({ signal }) => {
      const verification = sessionVerificationGeneration();
      try {
        const identity = await readAuthResource<PlatformSession>('me', signal);
        if (verification !== sessionVerificationGeneration())
          throw new Error(
            'Session verification was superseded; recheck identity',
          );
        if (!acceptVerifiedSession(identity) && identity.active)
          throw new AuthIdentityChangedError();
        return identity;
      } catch (error) {
        if (!signal.aborted) pauseSession();
        throw error;
      }
    },
    staleTime: 10_000,
    refetchInterval: (current) =>
      isSessionTransportError(current.state.error) ? false : 30_000,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: (attempt, error) =>
      shouldRetryPlatformSession(attempt, error, hasVerifiedSession()),
    retryDelay: (attemptIndex) =>
      SESSION_RETRY_DELAYS_MS[
        Math.min(attemptIndex, SESSION_RETRY_DELAYS_MS.length - 1)
      ],
  });
  // This must survive the workspace being hidden after a failed identity probe.
  // Do not replay mutations, and do not keep rendering a cached active identity.
  const { refetch } = query;
  useEffect(() => {
    if (!isSessionTransportError(query.error)) return;
    // A server restart does not trigger the browser's `online`/focus events.
    // Keep this timer outside the protected workspace and avoid overlapping
    // probes or replaying the update mutation. Never grant access from cache.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine)
        void refetch({ cancelRefetch: false });
    }, SESSION_RECOVERY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [query.error, refetch]);
  useEffect(() => {
    let lastRecovery = 0;
    const recover = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastRecovery < 10_000) return;
      lastRecovery = now;
      void refetch({ cancelRefetch: false });
    };
    window.addEventListener('pageshow', recover);
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    const expired = () => {
      clearApiToken();
      pauseSession();
      void refetch({ cancelRefetch: false });
    };
    window.addEventListener('codex-webui:auth-expired', expired);
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.removeEventListener('pageshow', recover);
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
      window.removeEventListener('codex-webui:auth-expired', expired);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [refetch]);
  return {
    ...query,
    paused,
    isAdministrator:
      !paused &&
      !query.isError &&
      query.data?.active === true &&
      query.data.role === 'administrator',
  };
}
