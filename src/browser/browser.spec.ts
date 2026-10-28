import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BrowserService, browserUrl } from './browser.service';
import { BrowserController } from './browser.controller';
const connect = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({ chromium: { connect } }));
let service: BrowserService;
const page = () => ({
  url: () => 'https://example.com/',
  title: vi.fn().mockResolvedValue('Example'),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('jpeg')),
  viewportSize: () => ({ width: 1000, height: 700 }),
  locator: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  goto: vi.fn().mockResolvedValue(undefined),
  mouse: { click: vi.fn().mockResolvedValue(undefined) },
});
beforeEach(() => {
  connect.mockReset();
  connect.mockImplementation(() =>
    Promise.resolve({
      close: vi.fn().mockResolvedValue(undefined),
      newContext: vi.fn().mockResolvedValue({
        setDefaultTimeout: vi.fn(),
        setDefaultNavigationTimeout: vi.fn(),
        route: vi.fn().mockResolvedValue(undefined),
        routeWebSocket: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        newPage: vi.fn().mockImplementation(() => Promise.resolve(page())),
      }),
    }),
  );
  service = new BrowserService(
    new ConfigService({
      MERGERON_BROWSER_ENDPOINT: 'ws://isolated:3000/secret',
    }),
  );
});
afterEach(() => service.onModuleDestroy());
it.each([
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,x',
  'https://user:password@example.com',
  'not a url',
])('rejects unsafe navigation %s', (value) => {
  expect(() => browserUrl(value)).toThrow();
});
it('accepts HTTP(S)', () => {
  expect(browserUrl('https://example.com/a?q=1#b')).toBe(
    'https://example.com/a?q=1#b',
  );
});
it('fails closed without a configured runtime', async () => {
  const disabled = new BrowserService(new ConfigService());
  await expect(disabled.run('owner', 'new', {})).rejects.toThrow(
    'not configured',
  );
  await disabled.onModuleDestroy();
  expect(connect).not.toHaveBeenCalled();
});
it('reports an explicit configuration code without leaking the runtime endpoint', async () => {
  const disabled = new BrowserService(new ConfigService());
  await expect(disabled.run('owner', 'new', {})).rejects.toMatchObject({
    response: { code: 'BROWSER_NOT_CONFIGURED' },
  });
  await disabled.onModuleDestroy();
  connect.mockRejectedValue(new Error('ws://private-endpoint/secret'));
  await expect(service.run('owner', 'new', {})).rejects.toMatchObject({
    response: {
      code: 'BROWSER_RUNTIME_UNAVAILABLE',
      message: 'Browser runtime unavailable',
    },
  });
});
it('reports invalid URL codes separately from runtime configuration', () => {
  expect.assertions(2);
  try {
    browserUrl('file:///private');
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    if (error instanceof BadRequestException)
      expect(error.getResponse()).toMatchObject({
        code: 'BROWSER_INVALID_URL',
      });
  }
});
it('isolates identifiers across people and conversations', async () => {
  const first = await service.run('alice/a', 'new', {});
  const id = 'id' in first ? first.id : '';
  await expect(service.run('bob/a', 'snapshot', { tabId: id })).rejects.toThrow(
    'not found',
  );
  await expect(
    service.run('alice/b', 'snapshot', { tabId: id }),
  ).rejects.toThrow('not found');
  expect(connect).toHaveBeenCalledTimes(3);
});
it('limits tabs and rejects stale images and invalid coordinates', async () => {
  const first = await service.run('alice', 'new', {});
  const tabId = 'id' in first ? first.id : '';
  const frame = await service.run('alice', 'snapshot', { tabId });
  await expect(
    service.run('alice', 'click', { tabId, frameId: 'old', x: 10, y: 10 }),
  ).rejects.toThrow('Refresh');
  await expect(
    service.run('alice', 'click', {
      tabId,
      frameId: 'frameId' in frame ? frame.frameId : '',
      x: -1,
      y: 10,
    }),
  ).rejects.toThrow('Invalid point');
  for (let i = 1; i < 5; i++) await service.run('alice', 'new', {});
  await expect(service.run('alice', 'new', {})).rejects.toThrow('Maximum');
});
it('closes a session without reusing its tabs', async () => {
  const first = await service.run('alice', 'new', {});
  const tabId = 'id' in first ? first.id : '';
  await service.run('alice', 'close', {});
  await expect(service.run('alice', 'snapshot', { tabId })).rejects.toThrow(
    'not found',
  );
  expect(connect).toHaveBeenCalledTimes(2);
});
it('checks rights before any remote browser operation', () => {
  const identities = {
    requireThread: vi.fn(),
    requireAdministrator: vi.fn(() => {
      throw new ForbiddenException();
    }),
  };
  const run = vi.fn();
  const controller = new BrowserController(
    { run } as never,
    identities as never,
  );
  const identity = {
    kind: 'person',
    personId: 'alice',
    role: 'standard',
    active: true,
  };
  expect(() =>
    controller.run('other', 'new', {}, { platformIdentity: identity } as never),
  ).toThrow();
  expect(identities.requireThread).toHaveBeenCalledWith(identity, 'other');
  expect(run).not.toHaveBeenCalled();
});

it('checks administrator and thread rights before hijacking a live response', async () => {
  const stream = vi.fn();
  const identities = {
    requireThread: vi.fn(),
    requireAdministrator: vi.fn(() => {
      throw new ForbiddenException();
    }),
  };
  const controller = new BrowserController(
    { stream } as never,
    identities as never,
  );
  const reply = { hijack: vi.fn() };
  await expect(
    controller.live(
      'thread',
      { tabId: 'tab' },
      { platformIdentity: { kind: 'person', personId: 'standard' } } as never,
      reply as never,
    ),
  ).rejects.toThrow();
  expect(stream).not.toHaveBeenCalled();
  expect(reply.hijack).not.toHaveBeenCalled();
});
