/// <reference types="node" />
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

function runtime() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const put = vi.fn();
  const remove = vi.fn();
  const response = (type: string, redirected = false) => ({
    ok: true,
    type: 'basic',
    redirected,
    headers: { get: () => type },
  });
  const fetch = vi.fn((request: { url: string }) =>
    Promise.resolve(
      response(
        request.url.endsWith('.webmanifest') ? 'text/html' : 'image/png',
        request.url.endsWith('.webmanifest'),
      ),
    ),
  );
  const context = vm.createContext({
    URL,
    Promise,
    Request: class {
      url: string;
      credentials: string;
      constructor(url: URL, options: { credentials: string }) {
        this.url = String(url);
        this.credentials = options.credentials;
      }
    },
    self: {
      registration: { scope: 'https://example.test/app/' },
      location: { origin: 'https://example.test' },
      addEventListener: (
        name: string,
        handler: (event: Record<string, unknown>) => void,
      ) => handlers.set(name, handler),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    },
    caches: {
      open: () => Promise.resolve({ put }),
      keys: () =>
        Promise.resolve([
          'unrelated-cache',
          'mergeron-static-v4',
          'mergeron-static-v6',
        ]),
      delete: remove,
      match: vi.fn(),
    },
    fetch,
  });
  vm.runInContext(readFileSync('public/sw.js', 'utf8'), context);
  return { handlers, put, remove, fetch };
}
it('preloads with credentials but never caches authentication redirects or HTML', async () => {
  const { handlers, put, fetch } = runtime();
  let done: Promise<unknown> | undefined;
  handlers.get('install')!({
    waitUntil: (promise: Promise<unknown>) => {
      done = promise;
    },
  });
  await done;
  expect(
    fetch.mock.calls.every(
      ([request]) =>
        (request as { credentials?: string }).credentials === 'include',
    ),
  ).toBe(true);
  expect(
    put.mock.calls.some(([request]) => request.url.endsWith('.webmanifest')),
  ).toBe(false);
  expect(put).toHaveBeenCalled();
});
it('does not intercept navigations or private/API paths even when they contain assets', () => {
  const { handlers } = runtime();
  for (const [url, mode] of [
    ['https://example.test/app/assets/page', 'navigate'],
    ['https://example.test/api/assets/private', 'cors'],
    ['https://example.test/api/files/serve', 'cors'],
    ['https://example.test/api/private/pwa-icon-192.png', 'cors'],
  ]) {
    const respondWith = vi.fn();
    handlers.get('fetch')!({
      request: { url, mode, method: 'GET' },
      respondWith,
    });
    expect(respondWith).not.toHaveBeenCalled();
  }
});
it('cleans only caches owned by Mergeron', async () => {
  const { handlers, remove } = runtime();
  let done: Promise<unknown> | undefined;
  handlers.get('activate')!({
    waitUntil: (promise: Promise<unknown>) => {
      done = promise;
    },
  });
  await done;
  expect(remove).toHaveBeenCalledExactlyOnceWith('mergeron-static-v4');
});
