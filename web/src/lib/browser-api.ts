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
  'BROWSER_CONTROL_REQUIRED',
  'BROWSER_STALE_VIEW',
]);
export class BrowserApiError extends Error {
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = 'BrowserApiError';
    this.status = status;
  }
}

export type BrowserLiveEvent =
  | { type: 'ready'; controlId: string }
  | {
      type: 'frame';
      image: string;
      width: number;
      height: number;
      url: string;
      title: string;
    }
  | { type: 'heartbeat' }
  | { type: 'error'; code: string };

/** Authenticated POST streaming: no bearer token or browser control endpoint in a URL. */
export async function browserLive(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  receive: (event: BrowserLiveEvent) => void,
) {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/browser${path}/live`), {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as {
      code?: string;
    };
    throw new BrowserApiError(
      response.status === 401 || response.status === 403
        ? 'BROWSER_ACCESS_DENIED'
        : knownErrors.has(payload.code ?? '')
          ? payload.code!
          : 'BROWSER_OPERATION_FAILED',
      response.status,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const item = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!item.startsWith('data: ') || item.length > 4_100_000)
          throw new BrowserApiError('BROWSER_OPERATION_FAILED');
        const event = JSON.parse(item.slice(6)) as BrowserLiveEvent;
        if (event.type === 'frame') {
          if (
            !event.image.startsWith('data:image/jpeg;base64,') ||
            !Number.isInteger(event.width) ||
            !Number.isInteger(event.height) ||
            event.width < 1 ||
            event.width > 1920 ||
            event.height < 1 ||
            event.height > 1200 ||
            typeof event.url !== 'string' ||
            typeof event.title !== 'string'
          )
            throw new BrowserApiError('BROWSER_OPERATION_FAILED');
        } else if (event.type === 'ready') {
          if (
            typeof event.controlId !== 'string' ||
            event.controlId.length > 100
          )
            throw new BrowserApiError('BROWSER_OPERATION_FAILED');
        } else if (event.type !== 'heartbeat' && event.type !== 'error')
          throw new BrowserApiError('BROWSER_OPERATION_FAILED');
        receive(event);
      }
      if (buffer.length > 4_100_000)
        throw new BrowserApiError('BROWSER_OPERATION_FAILED');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function browserApi<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
        : AbortSignal.timeout(45_000),
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
