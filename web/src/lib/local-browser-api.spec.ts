import { afterEach, expect, it, vi } from 'vitest';
import {
  extensionRequest,
  localBrowserApi,
  LOCAL_BROWSER_CHANNEL,
} from './local-browser-api';
vi.mock('@/auth-token', () => ({
  getAuthorizationHeader: () => 'Bearer test-only-credential',
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps authentication in the API request and sends none to the extension bridge', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: 'session' }) });
  vi.stubGlobal('fetch', fetch);
  await localBrowserApi('agent', 'open');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe(
    'Bearer test-only-credential',
  );
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const pending = extensionRequest('pair', {
    sessionId: 'session',
    threadId: 'agent',
  });
  const payload = post.mock.calls[0][0];
  expect(JSON.stringify(payload)).not.toContain('credential');
  expect(post.mock.calls[0][1]).toBe(location.origin);
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      source: window,
      data: {
        channel: LOCAL_BROWSER_CHANNEL,
        kind: 'response',
        id: payload.id,
        result: { ok: true },
      },
    }),
  );
  await expect(pending).resolves.toEqual({ ok: true });
});
it('ignores foreign origins and preserves definite page errors as command results', async () => {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const pending = extensionRequest('execute', {
    sessionId: 'session',
    command: {},
  });
  const id = post.mock.calls[0][0].id;
  const data = {
    channel: LOCAL_BROWSER_CHANNEL,
    kind: 'response',
    id,
    result: { error: 'STALE_PAGE_OBSERVE_AGAIN' },
  };
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: 'https://other.example',
      source: window,
      data: { ...data, result: { ok: true } },
    }),
  );
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      source: window,
      data,
    }),
  );
  await expect(pending).resolves.toEqual({ error: 'STALE_PAGE_OBSERVE_AGAIN' });
});
