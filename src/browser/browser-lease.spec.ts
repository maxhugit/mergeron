import { afterEach, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { BrowserService } from './browser.service';
import type { streamBrowserPage } from './browser-live';
const stream = vi.hoisted(() => vi.fn<typeof streamBrowserPage>());
const page = vi.hoisted(() => ({
  isClosed: () => false,
  url: () => 'https://example.com/',
  title: () => Promise.resolve('Example'),
  close: vi.fn(),
  viewportSize: () => ({ width: 1000, height: 700 }),
  keyboard: { insertText: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./browser-live', async (original) => ({
  ...(await original<typeof import('./browser-live')>()),
  streamBrowserPage: stream,
}));
vi.mock('playwright-core', () => ({
  chromium: {
    connect: () =>
      Promise.resolve({
        close: () => Promise.resolve(),
        newContext: () =>
          Promise.resolve({
            on: vi.fn(),
            route: vi.fn(),
            routeWebSocket: vi.fn(),
            setDefaultTimeout: vi.fn(),
            setDefaultNavigationTimeout: vi.fn(),
            newPage: () => Promise.resolve(page),
          }),
      }),
  },
}));
let service: BrowserService | undefined;
afterEach(async () => {
  await service?.onModuleDestroy();
  service = undefined;
  vi.clearAllMocks();
});

it('binds input to the current control lease, rejects concurrent claimants and revokes replaced controllers', async () => {
  stream.mockImplementation(
    (_context, _page, signal: AbortSignal, emit, _authorize, controlId) => {
      void emit({ type: 'ready', controlId });
      return new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  );
  service = new BrowserService(
    new ConfigService({ MERGERON_BROWSER_ENDPOINT: 'ws://isolated/secret' }),
  );
  const created = await service.run('owner', 'new', {});
  const tabId = 'id' in created ? created.id : '';
  const firstEvents: Record<string, unknown>[] = [];
  const first = service.stream(
    'owner',
    { tabId },
    new AbortController().signal,
    (event) => {
      firstEvents.push(event);
      return Promise.resolve();
    },
    () => {},
  );
  const firstToken = firstEvents[0].controlId;
  await expect(
    service.stream(
      'owner',
      { tabId, previousControlId: 'wrong' },
      new AbortController().signal,
      () => Promise.resolve(),
      () => {},
    ),
  ).rejects.toMatchObject({ response: { code: 'BROWSER_CONTROL_REQUIRED' } });
  const input = {
    tabId,
    url: 'https://example.com/',
    width: 1000,
    height: 700,
    events: [{ type: 'text', text: 'hello' }],
  };
  await expect(
    service.run('owner', 'input', { ...input, controlId: 'wrong' }),
  ).rejects.toMatchObject({ response: { code: 'BROWSER_CONTROL_REQUIRED' } });
  await service.run('owner', 'input', { ...input, controlId: firstToken });
  expect(page.keyboard.insertText).toHaveBeenCalledOnce();
  await expect(
    service.stream(
      'other-owner',
      { tabId },
      new AbortController().signal,
      () => Promise.resolve(),
      () => {},
    ),
  ).rejects.toMatchObject({ response: { code: 'BROWSER_TAB_MISSING' } });
  const nextAbort = new AbortController();
  const events: Record<string, unknown>[] = [];
  const next = service.stream(
    'owner',
    { tabId, previousControlId: firstToken },
    nextAbort.signal,
    (event) => {
      events.push(event);
      return Promise.resolve();
    },
    () => {},
  );
  const race = service.stream(
    'owner',
    { tabId, takeControl: true },
    new AbortController().signal,
    () => Promise.resolve(),
    () => {},
  );
  await expect(race).rejects.toMatchObject({
    response: { code: 'BROWSER_CONTROL_REQUIRED' },
  });
  await first;
  expect(events[0].controlId).not.toBe(firstToken);
  await expect(
    service.run('owner', 'input', { ...input, controlId: firstToken }),
  ).rejects.toMatchObject({ response: { code: 'BROWSER_CONTROL_REQUIRED' } });
  nextAbort.abort();
  await next;
  await expect(
    service.run('owner', 'input', { ...input, controlId: events[0].controlId }),
  ).rejects.toMatchObject({ response: { code: 'BROWSER_CONTROL_REQUIRED' } });
  expect(page.keyboard.insertText).toHaveBeenCalledOnce();
});
