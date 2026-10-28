import { afterEach, expect, it, vi } from 'vitest';
import { browserApi, browserLive, BrowserApiError } from './browser-api';
vi.mock('@/auth-token', () => ({ getAuthorizationHeader: () => undefined }));
afterEach(() => vi.unstubAllGlobals());
it('reads split live events using authenticated POST without tokens in URLs', async () => {
  const encoder = new TextEncoder();
  const receive = vi.fn();
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"rea'));
          controller.enqueue(
            encoder.encode(
              'dy","controlId":"lease"}\n\ndata: {"type":"heartbeat"}\n\n',
            ),
          );
          controller.close();
        },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await browserLive(
    '/thread',
    { tabId: 'tab' },
    new AbortController().signal,
    receive,
  );
  expect(receive.mock.calls.map(([event]) => event.type)).toEqual([
    'ready',
    'heartbeat',
  ]);
  expect(fetch.mock.calls[0][0]).toBe('/api/browser/thread/live');
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
    body: '{"tabId":"tab"}',
  });
});
it('rejects oversized or non-image frames rather than embedding arbitrary content', async () => {
  const receive = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          'data: {"type":"frame","image":"javascript:alert(1)","width":800,"height":500}\n\n',
        ),
      ),
  );
  await expect(
    browserLive('/thread', {}, new AbortController().signal, receive),
  ).rejects.toThrow('BROWSER_OPERATION_FAILED');
  expect(receive).not.toHaveBeenCalled();
});
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
