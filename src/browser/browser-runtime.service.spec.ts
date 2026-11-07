import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { BrowserRuntimeService } from './browser-runtime.service';
import type { ManagerStatusService } from '../settings/manager-status.service';
let runtime: BrowserRuntimeService;
const call =
  vi.fn<
    (body: { owner: string; release: boolean }) => Promise<{ state: string }>
  >();
beforeEach(() => {
  vi.useFakeTimers();
  call.mockReset().mockResolvedValue({ state: 'ready' });
  runtime = new BrowserRuntimeService(
    { browserRuntime: call } as unknown as ManagerStatusService,
    new ConfigService(),
  );
});
afterEach(async () => {
  await runtime.onModuleDestroy();
  vi.useRealTimers();
});
it('uses one process owner, retains live sessions and releases only after the last session', async () => {
  await runtime.prepare('a');
  runtime.retain('a');
  await runtime.prepare('b');
  runtime.retain('b');
  expect(call.mock.calls[0][0].owner).toBe(call.mock.calls[1][0].owner);
  call.mockClear();
  await runtime.release('a');
  expect(call).not.toHaveBeenCalled();
  await runtime.release('b');
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ release: true }));
});
it('waits for the real health result rather than treating starting as ready', async () => {
  call
    .mockResolvedValueOnce({ state: 'starting' })
    .mockResolvedValueOnce({ state: 'ready' });
  const ready = runtime.ready('a');
  await vi.advanceTimersByTimeAsync(1000);
  await ready;
  expect(call).toHaveBeenCalledTimes(2);
});
it('does not hide a Manager failure; older Manager and explicit external mode remain supported', async () => {
  call.mockRejectedValueOnce(new HttpException('unavailable', 503));
  await expect(runtime.prepare('a')).rejects.toThrow();
  call.mockRejectedValueOnce(new HttpException('notFound', 404));
  expect(await runtime.prepare('a')).toEqual({ state: 'external' });
  const external = new BrowserRuntimeService(
    { browserRuntime: call } as unknown as ManagerStatusService,
    new ConfigService({ MERGERON_BROWSER_LIFECYCLE: 'external' }),
  );
  call.mockClear();
  await external.ready('a');
  expect(call).not.toHaveBeenCalled();
  await external.onModuleDestroy();
});
it('transient cancelled preparations expire without making another session lose its lease', async () => {
  await runtime.prepare('cancelled');
  await runtime.prepare('active');
  runtime.retain('active');
  await runtime.release('cancelled');
  call.mockClear();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(call).toHaveBeenCalled();
  expect(call.mock.calls.every(([body]) => body.release === false)).toBe(true);
});

it('keeps the dynamically installed browser credential private and rejects arbitrary endpoints', async () => {
  const endpoint = 'ws://mergeron-dev-browser:3000/' + 'a'.repeat(64);
  call.mockResolvedValueOnce({ state: 'ready', transport: { endpoint } } as {
    state: string;
  });
  const status = await runtime.prepare('new');
  expect(status).toEqual({ state: 'ready' });
  expect(runtime.endpoint()).toBe(endpoint);
  call.mockResolvedValueOnce({
    state: 'ready',
    transport: { endpoint: 'ws://evil.invalid/secret' },
  } as { state: string });
  expect(await runtime.prepare('again')).toEqual({ state: 'ready' });
  expect(runtime.endpoint()).toBe(endpoint);
});
