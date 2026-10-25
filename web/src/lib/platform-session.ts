import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

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
}

const SESSION_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
export const AUTH_REQUEST_TIMEOUT_MS = 12_000;

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

/** Reload only the current protected URL; never trust a redirect target from fetch. */
export function renewProxySession(now = Date.now()): boolean {
  const key = 'mergeron.auth-navigation-at';
  try {
    const last = Number(sessionStorage.getItem(key));
    if (last && now - last < 5 * 60_000) return false;
    sessionStorage.setItem(key, String(now));
  } catch {
    // Without durable loop protection, leave navigation to the explicit button.
    return false;
  }
  window.location.reload();
  return true;
}

export function shouldRetryPlatformSession(
  failureCount: number,
  error: Error,
): boolean {
  if (failureCount >= SESSION_RETRY_DELAYS_MS.length) return false;
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
  const query = useQuery({
    queryKey: platformSessionKey,
    queryFn: ({ signal }) => readAuthResource<PlatformSession>('me', signal),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: shouldRetryPlatformSession,
    retryDelay: (attemptIndex) =>
      SESSION_RETRY_DELAYS_MS[
        Math.min(attemptIndex, SESSION_RETRY_DELAYS_MS.length - 1)
      ],
  });
  // This must survive the workspace being hidden after a failed identity probe.
  // Do not replay mutations, and do not keep rendering a cached active identity.
  const { refetch } = query;
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
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.removeEventListener('pageshow', recover);
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [refetch]);
  useEffect(() => {
    if (
      query.error instanceof AuthRedirectError &&
      navigator.onLine &&
      document.visibilityState === 'visible'
    )
      renewProxySession();
  }, [query.error]);
  return {
    ...query,
    isAdministrator:
      query.data?.active === true && query.data.role === 'administrator',
  };
}
