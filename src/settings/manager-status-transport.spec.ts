/** Mocked Unix HTTP only: no native engine, network, credentials or account. */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { ConfigService } from '@nestjs/config';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagerStatusService } from './manager-status.service';

vi.mock('node:http', () => ({ default: { request: vi.fn() } }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function fixture() {
  const request = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn((error: Error) => {
      request.emit('error', error);
      request.emit('close');
      return request;
    }),
  });
  vi.mocked(http.request).mockReturnValue(request as never);
  const openResponse = (statusCode = 200) => {
    const response = Object.assign(new EventEmitter(), {
      statusCode,
      setEncoding: vi.fn(),
    });
    const callback = vi.mocked(http.request).mock.calls[0][1] as unknown as (
      response: unknown,
    ) => void;
    callback(response);
    return response;
  };
  const respond = (body: string, statusCode = 200) => {
    const response = openResponse(statusCode);
    response.emit('data', body);
    response.emit('end');
    request.emit('close');
  };
  return {
    request,
    respond,
    openResponse,
    service: new ManagerStatusService(new ConfigService()),
  };
}

it('allows an update plan slower than three seconds without retrying or starting an update', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = f.service.updateOperation('plan', {
    images: { application: 'approved' },
    mode: 'dev-fast',
  });
  expect(vi.mocked(http.request).mock.calls[0][0]).toMatchObject({
    path: '/v1/update/plan',
    timeout: 30000,
  });
  await vi.advanceTimersByTimeAsync(4500);
  expect(f.request.destroy).not.toHaveBeenCalled();
  f.respond(JSON.stringify({ applicable: true, fingerprint: 'verified' }));
  await expect(result).resolves.toMatchObject({ applicable: true });
  expect(http.request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a stalled response stream even if data keeps arriving', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const rejected = expect(
    f.service.updateOperation('plan', {}),
  ).rejects.toMatchObject({ status: 504 });
  const response = f.openResponse();
  response.emit('data', '{');
  await vi.advanceTimersByTimeAsync(29000);
  response.emit('data', ' ');
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(http.request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['aborted', 'oversized'])(
  'rejects an %s response without leaking data or retrying',
  async (kind) => {
    const f = fixture();
    const rejected = expect(
      f.service.updateOperation('plan', {}),
    ).rejects.toMatchObject({
      status: 502,
      message: 'mergeronManagerInvalidResponse',
    });
    const response = f.openResponse();
    if (kind === 'aborted') response.emit('aborted');
    else response.emit('data', 'x'.repeat(1024 * 1024 + 1));
    await rejected;
    expect(http.request).toHaveBeenCalledTimes(1);
  },
);

it.each(['plan', 'apply', 'rollback', 'recover'] as const)(
  'bounds %s at thirty seconds with a safe 504 and no write retry',
  async (action) => {
    vi.useFakeTimers();
    const f = fixture();
    const rejected = expect(
      f.service.updateOperation(action, {}),
    ).rejects.toMatchObject({ status: 504, message: 'mergeronManagerTimeout' });
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('keeps short status polling and the offline CLI install budget separate', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const status = f.service.status();
  expect(vi.mocked(http.request).mock.calls[0][0]).toMatchObject({
    timeout: 3000,
  });
  await vi.advanceTimersByTimeAsync(3000);
  await expect(status).resolves.toMatchObject({
    available: false,
    error: 'mergeronManagerUnavailable',
  });
  vi.mocked(http.request).mockClear();
  const rejected = expect(
    f.service.installCodexCli('release', 'digest'),
  ).rejects.toMatchObject({ status: 504 });
  expect(vi.mocked(http.request).mock.calls[0][0]).toMatchObject({
    timeout: 210000,
  });
  await vi.advanceTimersByTimeAsync(210000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('does not expose raw socket failures as internal errors or leak their diagnostics', async () => {
  const f = fixture();
  const result = expect(
    f.service.updateOperation('plan', {}),
  ).rejects.toMatchObject({
    status: 503,
    message: 'mergeronManagerUnavailable',
  });
  f.request.emit('error', new Error('EACCES private path and secret'));
  f.request.emit('close');
  await result;
  expect(http.request).toHaveBeenCalledTimes(1);
});

it.each(['not-json', '[]', 'null', '"not an object"'])(
  'maps malformed Manager output %s to a safe 502',
  async (body) => {
    const f = fixture();
    const result = expect(
      f.service.updateOperation('plan', {}),
    ).rejects.toMatchObject({
      status: 502,
      message: 'mergeronManagerInvalidResponse',
    });
    f.respond(body);
    await result;
  },
);

it('preserves a structured Manager refusal instead of hiding a protection failure', async () => {
  const f = fixture();
  const result = expect(
    f.service.updateOperation('plan', {}),
  ).rejects.toMatchObject({ status: 409, message: 'updatePlanChanged' });
  f.respond(JSON.stringify({ error: 'updatePlanChanged' }), 409);
  await result;
});

it('cleans up a prematurely closed request instead of waiting forever', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = expect(f.service.backups()).rejects.toMatchObject({
    status: 503,
  });
  f.request.emit('close');
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
