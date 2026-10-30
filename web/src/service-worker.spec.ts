/// <reference types="node" />
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

function runtime() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const put = vi.fn();
  const remove = vi.fn();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const windows: {
    url: string;
    navigate: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  }[] = [];
  const openWindow = vi.fn().mockResolvedValue(undefined);
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
      registration: { scope: 'https://example.test/app/', showNotification },
      location: { origin: 'https://example.test' },
      addEventListener: (
        name: string,
        handler: (event: Record<string, unknown>) => void,
      ) => handlers.set(name, handler),
      skipWaiting: vi.fn(),
      clients: {
        claim: vi.fn(),
        matchAll: vi.fn().mockResolvedValue(windows),
        openWindow,
      },
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
  return {
    handlers,
    put,
    remove,
    fetch,
    showNotification,
    windows,
    openWindow,
  };
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
it('shows generic localized alerts with a stable tag, never supplied titles/HTML/URLs', async () => {
  const { handlers, showNotification } = runtime();
  const data = {
    version: 1,
    id: 'event-1',
    kind: 'approvals',
    threadId: 'thread-1',
    language: 'fr',
    title: 'secret command',
    body: '<img onerror=alert(1)>',
    url: 'https://evil.test',
  };
  let done: Promise<unknown> | undefined;
  handlers.get('push')!({
    data: { text: () => JSON.stringify(data), json: () => data },
    waitUntil: (promise: Promise<unknown>) => {
      done = promise;
    },
  });
  await done;
  const [title, options] = showNotification.mock.calls[0];
  expect(title).toBe('Mergeron — Votre attention est requise');
  expect(options).toMatchObject({
    tag: 'mergeron:event-1',
    renotify: false,
    body: 'Ouvrez Mergeron pour consulter les détails.',
  });
  expect(JSON.stringify(options)).not.toMatch(/secret|onerror|evil/);
});
it('ignores malformed, oversize and unsafe push envelopes', () => {
  const { handlers, showNotification } = runtime();
  for (const data of [
    {},
    { version: 1, id: 'x', kind: 'completed', threadId: '//evil.test' },
    { version: 1, id: 'x', kind: 'unknown' },
    { version: 1, id: 'x', kind: 'test', padding: 'a'.repeat(3000) },
  ]) {
    handlers.get('push')!({
      data: { text: () => JSON.stringify(data), json: () => data },
      waitUntil: vi.fn(),
    });
  }
  handlers.get('push')!({
    data: {
      text: () => '{',
      json: () => {
        throw Error();
      },
    },
  });
  expect(showNotification).not.toHaveBeenCalled();
});
it('clicks only open a safe conversation inside the application base path, focusing an existing app', async () => {
  const { handlers, windows, openWindow } = runtime();
  const close = vi.fn();
  let done: Promise<unknown> | undefined;
  const event = {
    notification: {
      close,
      data: { version: 1, id: 'e', kind: 'completed', threadId: 't1' },
    },
    waitUntil: (promise: Promise<unknown>) => {
      done = promise;
    },
  };
  handlers.get('notificationclick')!(event);
  await done;
  expect(openWindow).toHaveBeenCalledExactlyOnceWith(
    'https://example.test/app/t/t1',
  );
  windows.push({
    url: 'https://example.test/unrelated/',
    navigate: vi.fn(),
    focus: vi.fn(),
  });
  const app = {
    url: 'https://example.test/app/t/other',
    navigate: vi.fn(),
    focus: vi.fn(),
  };
  windows.push(app);
  handlers.get('notificationclick')!(event);
  await done;
  expect(app.navigate).toHaveBeenCalledExactlyOnceWith(
    'https://example.test/app/t/t1',
  );
  expect(app.focus).toHaveBeenCalledOnce();
  expect(windows[0].navigate).not.toHaveBeenCalled();
  event.notification.data.threadId = '../api/admin';
  handlers.get('notificationclick')!(event);
  expect(openWindow).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(3);
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
