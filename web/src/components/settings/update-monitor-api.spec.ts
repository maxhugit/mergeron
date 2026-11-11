import { afterEach, expect, it, vi } from 'vitest';
import {
  discoverRunningUpdate,
  ensureUpdateMonitor,
} from './update-monitor-api';
vi.mock('@/auth-token', () => ({
  getAuthorizationHeader: () => 'Bearer existing-admin-session',
}));
afterEach(() => vi.unstubAllGlobals());
it('reuses the path-scoped monitoring session without minting another grant', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  await ensureUpdateMonitor();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    '/_mergeron-update/status',
    expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
  );
});
it('authorizes a browser opening an existing operation without leaking its token into a URL', async () => {
  const token = 'a'.repeat(64);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ token })))
    .mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  await ensureUpdateMonitor();
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    '/api/settings/manager/update/monitor',
    expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer existing-admin-session' },
    }),
  );
  expect(fetcher).toHaveBeenNthCalledWith(
    3,
    '/_mergeron-update/session',
    expect.objectContaining({ method: 'POST', body: token }),
  );
  expect(
    fetcher.mock.calls.every(([url]) => !String(url).includes(token)),
  ).toBe(true);
});

it.each([
  { id: '12345678-1234-1234-1234-123456789abc', status: 'succeeded' },
  { id: '../api/private', status: 'running' },
  null,
])(
  'does not discover completed or invalid operations: %j',
  async (operation) => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ operation }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await discoverRunningUpdate(new AbortController().signal),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it('does not request a protected grant when the independent service is down rather than unauthorized', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response('{}', { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(ensureUpdateMonitor()).rejects.toThrow(
    'updateMonitorUnavailable',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('validates and bounds the independent journal without importing private fields', async () => {
  const { readUpdateMonitor } = await import('./update-monitor-api');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          observedAt: '2026-11-11T00:00:00Z',
          operation: {
            id: 'operation',
            status: 'running',
            phase: 'managerChecking',
            actor: 'PRIVATE',
            error: 'PRIVATE',
            images: { secret: 'PRIVATE' },
            events: Array.from({ length: 300 }, () => ({
              at: '2026-11-11T00:00:00Z',
              phase: 'managerChecking',
              status: 'running',
              private: 'PRIVATE',
            })),
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
  const result = await readUpdateMonitor(new AbortController().signal);
  expect(result.operation?.events).toHaveLength(200);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it.each([
  new Response('<html>Login</html>', {
    headers: { 'content-type': 'text/html' },
  }),
  new Response('{}', { status: 401 }),
  new Response('{"operation":null}', {
    headers: { 'content-type': 'application/json' },
  }),
])(
  'does not present authentication or malformed replies as an independent progress snapshot',
  async (response) => {
    const { readUpdateMonitor } = await import('./update-monitor-api');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(
      readUpdateMonitor(new AbortController().signal),
    ).rejects.toThrow();
  },
);
