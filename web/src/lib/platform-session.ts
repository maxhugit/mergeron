import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { clearApiToken, getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import {
  recordSessionDiagnostic,
  type SessionDiagnosticReason,
  type SessionDiagnosticEntry,
} from './session-diagnostics';
import {
  acceptVerifiedSession,
  hasVerifiedSession,
  pauseSession,
  isSessionPaused,
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
  fastNavigationProjectId?: string | null;
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
export const SESSION_CHECK_INTERVAL_MS = 30_000;

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

function diagnosticReason(error: unknown): SessionDiagnosticReason {
  if (error instanceof AuthRedirectError) return 'proxy_redirect';
  if (error instanceof AuthIdentityChangedError) return 'identity_changed';
  if (error instanceof AuthResourceError) {
    if (error.status === 401) return 'unauthorized';
    if (error.status === 403) return 'forbidden';
    if (error.status === 408) return 'timeout';
    if (error.status === 429) return 'rate_limited';
    if (error.status >= 500) return 'server_unavailable';
    return 'invalid_response';
  }
  if (
    error instanceof Error &&
    ['TimeoutError', 'AbortError'].includes(error.name)
  )
    return 'timeout';
  if (error instanceof SyntaxError || error instanceof AuthResponseError)
    return 'invalid_response';
  return 'transport';
}
class AuthResponseError extends Error {}

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
      throw new AuthResponseError('Identity endpoint did not return JSON');
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
/** One owner per query client, not one set of timers/listeners per UI consumer. */
const recoveryOwners = new WeakMap<
  QueryClient,
  { users: number; dispose(): void }
>();

function retainSessionRecovery(client: QueryClient) {
  let entry = recoveryOwners.get(client);
  if (!entry) {
    let lastRequest = 0;
    let requestedGeneration = -1;
    const query = () =>
      client
        .getQueryCache()
        .find({ queryKey: platformSessionKey, exact: true });
    const verify = (
      required = false,
      trigger?: SessionDiagnosticEntry['trigger'],
    ) => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const current = query();
      if (!current) return;
      const now = Date.now();
      const generation = sessionVerificationGeneration();
      // Repeated focus/pageshow/online events share one live probe. A probe
      // predating a newly closed gate cannot authorize that generation.
      if (
        current.state.fetchStatus === 'fetching' &&
        requestedGeneration === generation
      )
        return;
      if (!required && now - lastRequest < 10_000) return;
      const superseded = required && requestedGeneration !== generation;
      lastRequest = now;
      requestedGeneration = generation;
      if (trigger) recordSessionDiagnostic('wake', { trigger, generation });
      void client.refetchQueries(
        { queryKey: platformSessionKey, exact: true, type: 'active' },
        { cancelRefetch: superseded },
      );
    };
    const recover = (event: Event) =>
      verify(
        isSessionPaused(),
        event.type as 'focus' | 'pageshow' | 'online' | 'visibilitychange',
      );
    const paused = (event: Event) => {
      if ((event as CustomEvent<{ reason?: string }>).detail?.reason === 'wake')
        verify(true);
    };
    const expired = () => {
      clearApiToken();
      pauseSession();
      verify(true, 'api_refusal');
    };
    const poll = window.setInterval(() => {
      const state = query()?.state;
      if (!state || state.fetchStatus === 'fetching') return;
      // Confirmed denials and identity changes never become restart polling.
      if (state.error) {
        if (isSessionTransportError(state.error)) verify(true, 'poll');
        return;
      }
      if (Date.now() - state.dataUpdatedAt >= SESSION_CHECK_INTERVAL_MS) {
        verify(isSessionPaused(), 'poll');
      }
    }, SESSION_RECOVERY_INTERVAL_MS);
    for (const name of ['pageshow', 'online', 'focus'])
      window.addEventListener(name, recover);
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('codex-webui:session-paused', paused);
    window.addEventListener('codex-webui:auth-expired', expired);
    entry = {
      users: 0,
      dispose: () => {
        window.clearInterval(poll);
        for (const name of ['pageshow', 'online', 'focus'])
          window.removeEventListener(name, recover);
        document.removeEventListener('visibilitychange', recover);
        window.removeEventListener('codex-webui:session-paused', paused);
        window.removeEventListener('codex-webui:auth-expired', expired);
      },
    };
    recoveryOwners.set(client, entry);
  }
  entry.users++;
  return () => {
    if (--entry.users === 0) {
      entry.dispose();
      recoveryOwners.delete(client);
    }
  };
}

export function usePlatformSession() {
  const client = useQueryClient();
  const paused = useSessionPaused();
  const query = useQuery({
    queryKey: platformSessionKey,
    queryFn: async ({ signal }) => {
      const verification = sessionVerificationGeneration();
      const started = performance.now();
      recordSessionDiagnostic('check_started', {
        generation: verification,
        online: navigator.onLine,
      });
      try {
        const identity = await readAuthResource<PlatformSession>('me', signal);
        if (verification !== sessionVerificationGeneration()) {
          recordSessionDiagnostic('response_discarded', {
            reason: 'superseded',
            generation: verification,
          });
          throw new Error(
            'Session verification was superseded; recheck identity',
          );
        }
        if (!acceptVerifiedSession(identity) && identity.active)
          throw new AuthIdentityChangedError();
        if (identity.active)
          recordSessionDiagnostic('check_succeeded', {
            generation: verification,
            durationMs: performance.now() - started,
            status: 200,
          });
        return identity;
      } catch (error) {
        recordSessionDiagnostic(
          signal.aborted ? 'check_cancelled' : 'check_failed',
          {
            reason:
              error instanceof AuthIdentityChangedError
                ? 'identity_changed'
                : signal.aborted ||
                    verification !== sessionVerificationGeneration()
                  ? 'superseded'
                  : diagnosticReason(error),
            generation: verification,
            durationMs: performance.now() - started,
            ...(error instanceof AuthResourceError &&
            !(error instanceof AuthRedirectError) &&
            !(error instanceof AuthIdentityChangedError)
              ? { status: error.status }
              : {}),
          },
        );
        if (!signal.aborted) pauseSession();
        throw error;
      }
    },
    staleTime: 10_000,
    // Recovery and polling are shared by all consumers of this identity.
    refetchInterval: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: (attempt, error) => {
      const retry = shouldRetryPlatformSession(
        attempt,
        error,
        hasVerifiedSession(),
      );
      if (retry)
        recordSessionDiagnostic('retry_scheduled', {
          reason: diagnosticReason(error),
          attempt: attempt + 1,
          delayMs:
            SESSION_RETRY_DELAYS_MS[
              Math.min(attempt, SESSION_RETRY_DELAYS_MS.length - 1)
            ],
          generation: sessionVerificationGeneration(),
        });
      return retry;
    },
    retryDelay: (attemptIndex) =>
      SESSION_RETRY_DELAYS_MS[
        Math.min(attemptIndex, SESSION_RETRY_DELAYS_MS.length - 1)
      ],
  });
  // The layout retains an observer while protected workspace effects are hidden.
  useEffect(() => retainSessionRecovery(client), [client]);
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
