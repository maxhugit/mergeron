import { afterEach, expect, it, vi } from 'vitest';
import { browserApi, BrowserApiError } from './browser-api';
vi.mock('@/auth-token', () => ({ getAuthorizationHeader: () => undefined }));
afterEach(() => vi.unstubAllGlobals());
it.each([
  'BROWSER_NOT_CONFIGURED',
  'BROWSER_RUNTIME_UNAVAILABLE',
  'BROWSER_NAVIGATION_FAILED',
  'BROWSER_INVALID_URL',
])(
  'preserves the safe browser error code %s without server diagnostics',
  async (code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code,
            message: 'private endpoint ws://private/secret',
          }),
          { status: 503 },
        ),
      ),
    );
    await expect(browserApi('/thread/new', {})).rejects.toMatchObject({
      name: 'BrowserApiError',
      message: code,
      status: 503,
    });
  },
);
it('never exposes proxy HTML or an arbitrary backend error as UI text', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('<h1>secret diagnostic</h1>', { status: 502 }),
      ),
  );
  await expect(browserApi('/thread/new', {})).rejects.toThrow(
    'BROWSER_OPERATION_FAILED',
  );
});
it('distinguishes authorization failures from configuration failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'BROWSER_NOT_CONFIGURED' }), {
        status: 403,
      }),
    ),
  );
  await expect(browserApi('/thread/new', {})).rejects.toThrow(
    'BROWSER_ACCESS_DENIED',
  );
});
it('distinguishes a connection failure and a timeout', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('private network error')),
  );
  await expect(browserApi('/thread/new', {})).rejects.toThrow(
    'BROWSER_NETWORK_ERROR',
  );
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValue(new DOMException('private details', 'TimeoutError')),
  );
  await expect(browserApi('/thread/new', {})).rejects.toBeInstanceOf(
    BrowserApiError,
  );
  await expect(browserApi('/thread/new', {})).rejects.toThrow(
    'BROWSER_TIMEOUT',
  );
});
