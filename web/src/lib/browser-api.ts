import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

const knownErrors = new Set([
  'BROWSER_NOT_CONFIGURED',
  'BROWSER_RUNTIME_UNAVAILABLE',
  'BROWSER_TIMEOUT',
  'BROWSER_BUSY',
  'BROWSER_TAB_LIMIT',
  'BROWSER_TAB_MISSING',
  'BROWSER_INVALID_URL',
  'BROWSER_NAVIGATION_FAILED',
  'BROWSER_OPERATION_FAILED',
]);
export class BrowserApiError extends Error {
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = 'BrowserApiError';
    this.status = status;
  }
}
export async function browserApi<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  let response: Response;
  try {
    response = await fetch(withBasePath(`/api/browser${path}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new BrowserApiError(
      (error instanceof Error || error instanceof DOMException) &&
        ['TimeoutError', 'AbortError'].includes(error.name)
        ? 'BROWSER_TIMEOUT'
        : 'BROWSER_NETWORK_ERROR',
    );
  }
  if (!response.ok) {
    let code: unknown;
    try {
      code = ((await response.json()) as { code?: unknown }).code;
    } catch {
      /* Never render an HTML proxy error or arbitrary server diagnostic. */
    }
    throw new BrowserApiError(
      response.status === 401 || response.status === 403
        ? 'BROWSER_ACCESS_DENIED'
        : typeof code === 'string' && knownErrors.has(code)
          ? code
          : 'BROWSER_OPERATION_FAILED',
      response.status,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new BrowserApiError('BROWSER_OPERATION_FAILED', response.status);
  }
}
