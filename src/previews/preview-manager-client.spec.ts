/** No socket, native engine, credentials or external account: mocked HTTP only. */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { ConfigService } from '@nestjs/config';
import { afterEach, expect, it, vi } from 'vitest';
import { PreviewManagerClient } from './preview-manager-client';

vi.mock('node:http', () => ({ default: { request: vi.fn() } }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function fixture() {
  const request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error: Error) => {
      request.emit('error', error);
      request.emit('close');
      return request;
    }),
  });
  vi.mocked(http.request).mockReturnValue(request as never);
  return { request, client: new PreviewManagerClient(new ConfigService()) };
}

it('bounds turn discovery even when the Unix request never connects', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = f.client.request('capabilities', {}, 1500);
  const rejected = expect(result).rejects.toThrow('PREVIEW_MANAGER_TIMEOUT');
  await vi.advanceTimersByTimeAsync(1500);
  await rejected;
  expect(f.request.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the discovery deadline when the request closes early', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = f.client.request('capabilities', {}, 1500);
  const rejected = expect(result).rejects.toThrow('fixture end');
  f.request.emit('error', new Error('fixture end'));
  f.request.emit('close');
  await rejected;
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.request.destroy).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not shorten an actual environment launch timeout', async () => {
  const f = fixture();
  const result = f.client.request('start');
  const rejected = expect(result).rejects.toThrow('fixture end');
  expect(vi.mocked(http.request).mock.calls[0][0]).toMatchObject({
    timeout: 180000,
  });
  f.request.emit('error', new Error('fixture end'));
  f.request.emit('close');
  await rejected;
});
