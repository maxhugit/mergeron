import { afterEach, expect, it, vi } from 'vitest';
import { GitHubReadScheduler } from './github-read-scheduler';
const repo = { owner: 'owner', repo: 'repo', token: 'private-token' };
const ok = () => new Response(JSON.stringify({ result: true }));
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('limits all repository reads to two, coalesces duplicates and releases queued work', async () => {
  const scheduler = new GitHubReadScheduler();
  let active = 0,
    peak = 0;
  const finish: (() => void)[] = [];
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        finish.push(() => {
          active--;
          // The runner's Node may deliver the response body on a later event-loop
          // turn. Releasing headers is not the end of the scheduled read.
          resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  setTimeout(() => {
                    controller.enqueue(
                      new TextEncoder().encode('{"result":true}'),
                    );
                    controller.close();
                  }, 0);
                },
              }),
            ),
          );
        });
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const reads = Array.from({ length: 6 }, (_, i) =>
    scheduler.read({ ...repo, repo: 'repo' + i }, 'pulls'),
  );
  const duplicate = scheduler.read({ ...repo, repo: 'repo0' }, 'pulls');
  await flush();
  expect(fetch).toHaveBeenCalledTimes(2);
  finish.shift()!();
  await reads[0];
  expect(fetch).toHaveBeenCalledTimes(3);
  for (let i = 1; i < 6; i++) {
    finish.shift()!();
    await reads[i];
  }
  await Promise.all([...reads, duplicate]);
  expect(peak).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('caches only explicitly cacheable reads and separates credentials and API versions', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fetch = vi.fn(() => Promise.resolve(ok()));
  vi.stubGlobal('fetch', fetch);
  const scheduler = new GitHubReadScheduler();
  await scheduler.read(repo, 'pulls', { cacheMs: 15000 });
  await scheduler.read(repo, 'pulls', { cacheMs: 15000 });
  expect(fetch).toHaveBeenCalledTimes(1);
  await scheduler.read({ ...repo, token: 'different' }, 'pulls', {
    cacheMs: 15000,
  });
  await scheduler.read(repo, 'pulls', {
    apiVersion: '2026-03-10',
    cacheMs: 15000,
  });
  await scheduler.read(repo, 'pulls');
  expect(fetch).toHaveBeenCalledTimes(4);
  vi.setSystemTime(15001);
  await scheduler.read(repo, 'pulls', { cacheMs: 15000 });
  expect(fetch).toHaveBeenCalledTimes(5);
});

it('backs off after connection failures without blaming credentials or exposing provider diagnostics', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fetch = vi.fn().mockRejectedValue(
    new TypeError('private-token', {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const scheduler = new GitHubReadScheduler();
  await expect(scheduler.read(repo, 'pulls')).rejects.toThrow(
    'GIT_GITHUB_TIMEOUT',
  );
  await expect(scheduler.read(repo, 'other')).rejects.toThrow(
    'GIT_GITHUB_TIMEOUT',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(5001);
  await expect(scheduler.read(repo, 'pulls')).rejects.toThrow(
    'GIT_GITHUB_TIMEOUT',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(10001);
  await expect(scheduler.read(repo, 'pulls')).rejects.toThrow(
    'GIT_GITHUB_TIMEOUT',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValue(ok());
  await scheduler.read({ ...repo, token: 'new' }, 'pulls');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  [401, 'GIT_GITHUB_AUTH'],
  [403, 'GIT_GITHUB_ACCESS'],
  [404, 'GIT_GITHUB_ACCESS'],
  [429, 'GIT_GITHUB_RATE_LIMIT'],
  [503, 'GIT_GITHUB_UNAVAILABLE'],
] as const)('reports HTTP %i separately', async (status, code) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response('private-provider-detail', { status })),
    ),
  );
  await expect(new GitHubReadScheduler().read(repo, 'pulls')).rejects.toThrow(
    code,
  );
});

it('honors rate-limit reset before allowing any further read with the same credentials', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' },
      }),
    )
    .mockImplementation(() => Promise.resolve(ok()));
  vi.stubGlobal('fetch', fetch);
  const scheduler = new GitHubReadScheduler();
  await expect(scheduler.read(repo, 'pulls')).rejects.toThrow(
    'GIT_GITHUB_RATE_LIMIT',
  );
  vi.setSystemTime(119999);
  await expect(scheduler.read(repo, 'other')).rejects.toThrow(
    'GIT_GITHUB_RATE_LIMIT',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(120001);
  await scheduler.read(repo, 'pulls');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not let a forbidden optional endpoint block permitted repository reads', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 403 }))
    .mockImplementation(() => Promise.resolve(ok()));
  vi.stubGlobal('fetch', fetch);
  const scheduler = new GitHubReadScheduler();
  await expect(scheduler.read(repo, 'actions/runs')).rejects.toThrow(
    'GIT_GITHUB_ACCESS',
  );
  await scheduler.read(repo, 'pulls');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('cancels a queued observation without consuming an execution slot or cooling down other reads', async () => {
  const finish: (() => void)[] = [];
  const fetch = vi.fn(
    () => new Promise<Response>((resolve) => finish.push(() => resolve(ok()))),
  );
  vi.stubGlobal('fetch', fetch);
  const scheduler = new GitHubReadScheduler();
  const first = scheduler.read(repo, 'first'),
    second = scheduler.read(repo, 'second');
  const controller = new AbortController();
  const cancelled = scheduler.read(repo, 'cancelled', {
    signal: controller.signal,
  });
  const expected = expect(cancelled).rejects.toThrow('budget');
  controller.abort(new Error('budget'));
  await expected;
  await flush();
  expect(fetch).toHaveBeenCalledTimes(2);
  finish.shift()!();
  finish.shift()!();
  await Promise.all([first, second]);
  const next = scheduler.read(repo, 'next');
  await flush();
  expect(fetch).toHaveBeenCalledTimes(3);
  finish.shift()!();
  await next;
});

it('bounds the waiting queue and does not mask an outage with a cached successful list', async () => {
  const finish: (() => void)[] = [];
  const fetch = vi.fn(
    () => new Promise<Response>((resolve) => finish.push(() => resolve(ok()))),
  );
  vi.stubGlobal('fetch', fetch);
  const scheduler = new GitHubReadScheduler();
  const reads = Array.from({ length: 66 }, (_, i) =>
    scheduler.read(repo, 'item/' + i),
  );
  await expect(scheduler.read(repo, 'overflow')).rejects.toThrow(
    'GIT_GITHUB_BUSY',
  );
  await flush();
  expect(fetch).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 66; i++) {
    finish.shift()!();
    await reads[i];
  }
  await Promise.all(reads);
  fetch.mockImplementation(() => Promise.resolve(ok()));
  await scheduler.read(repo, 'list', { cacheMs: 15000 });
  fetch.mockRejectedValueOnce(new Error('offline'));
  await expect(scheduler.read(repo, 'other')).rejects.toThrow(
    'GIT_GITHUB_NETWORK',
  );
  await expect(
    scheduler.read(repo, 'list', { cacheMs: 15000 }),
  ).rejects.toThrow('GIT_GITHUB_NETWORK');
});
