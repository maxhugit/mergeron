import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceGitService } from './workspace-git.service';
import type { WorkspaceResourcesService } from './workspace-resources.service';
import type { WorkspaceCopiesService } from './workspace-copies.service';

const resolve = vi.fn();
const copies = { list: vi.fn() };
const service = new WorkspaceGitService(
  copies as unknown as WorkspaceCopiesService,
  { resolveForTransfer: resolve } as unknown as WorkspaceResourcesService,
);
const sha = 'b'.repeat(40);
const response = (value: unknown) => ({
  ok: true,
  json: () => Promise.resolve(value),
});
const mergedPr = (number: number, mergedAt: string | null) => ({
  number,
  title: `Merge ${number}`,
  merged_at: mergedAt,
  head: { ref: 'feature' },
  base: { ref: 'main' },
  html_url: 'javascript:alert(1)',
});
beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockReturnValue({
    resource: {
      enabled: true,
      type: 'git',
      address: 'https://github.com/example/demo.git',
    },
    secret: { token: 'private-token' },
  });
});
afterEach(() => vi.unstubAllGlobals());

it('lists only merged PRs by merge date, bounds results, and builds safe URLs', async () => {
  const closed = [
    mergedPr(99, null),
    ...Array.from({ length: 7 }, (_, i) =>
      mergedPr(i + 1, `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`),
    ),
  ];
  const fetch = vi.fn().mockResolvedValue(response(closed));
  vi.stubGlobal('fetch', fetch);
  const result = await service.merges('project', 'connection');
  expect(result.items.map((pr) => pr.number)).toEqual([7, 6, 5, 4, 3]);
  expect(result.limited).toBe(true);
  expect(result.items[0].url).toBe('https://github.com/example/demo/pull/7');
  expect(fetch).toHaveBeenCalledWith(
    'https://api.github.com/repos/example/demo/pulls?state=closed&per_page=30&sort=updated&direction=desc',
    expect.objectContaining({
      redirect: 'error',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher.
      headers: expect.objectContaining({
        Authorization: 'Bearer private-token',
      }),
    }),
  );
  expect(copies.list).not.toHaveBeenCalled();
});

it('reads the merge SHA rather than the old PR head and combines jobs and statuses', async () => {
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/pulls/12'))
      return Promise.resolve(
        response({
          merged: true,
          merge_commit_sha: sha,
          head: { sha: 'a'.repeat(40) },
        }),
      );
    if (url.includes(`/commits/${sha}/check-runs?`))
      return Promise.resolve(
        response({
          total_count: 101,
          check_runs: [
            {
              id: 1,
              name: 'Build after merge',
              status: 'completed',
              conclusion: 'failure',
            },
            { id: 2, name: 'Deploy', status: 'queued', conclusion: null },
          ],
        }),
      );
    if (url.includes(`/commits/${sha}/status?`))
      return Promise.resolve(
        response({
          total_count: 1,
          statuses: [{ id: 3, context: 'External CI', state: 'pending' }],
        }),
      );
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  expect(
    await service.mergeChecks('project', 'connection', '12'),
  ).toMatchObject({
    head: sha,
    limited: true,
    url: `https://github.com/example/demo/commit/${sha}/checks`,
    items: [{ status: 'failure' }, { status: 'queued' }, { status: 'pending' }],
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  { merged: false, merge_commit_sha: sha },
  { merged: true, merge_commit_sha: null },
  { merged: true, merge_commit_sha: '../../other' },
])(
  'refuses absent or unsafe merge revisions before checking jobs: %j',
  async (pr) => {
    const fetch = vi.fn().mockResolvedValue(response(pr));
    vi.stubGlobal('fetch', fetch);
    await expect(
      service.mergeChecks('project', 'connection', '12'),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('validates identifiers before contacting GitHub', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    service.mergeChecks('project', 'connection', '../secret'),
  ).rejects.toThrow('Invalid pull request');
  expect(fetch).not.toHaveBeenCalled();
});

it('signals a truncated history even when all 30 recently closed PRs were not merged', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        response(Array.from({ length: 30 }, (_, i) => mergedPr(i + 1, null))),
      ),
  );
  expect(await service.merges('project', 'connection')).toMatchObject({
    supported: true,
    limited: true,
    items: [],
  });
});

it('preserves provider restrictions and sanitizes access errors', async () => {
  resolve.mockReturnValue({
    resource: {
      enabled: true,
      type: 'git',
      address: 'https://gitlab.example/demo.git',
    },
  });
  expect(await service.merges('project', 'connection')).toMatchObject({
    supported: false,
    items: [],
  });
  resolve.mockReturnValue({ resource: { enabled: false, type: 'git' } });
  await expect(service.merges('project', 'connection')).rejects.toThrow(
    'unavailable',
  );
  resolve.mockReturnValue({
    resource: {
      enabled: true,
      type: 'git',
      address: 'https://github.com/example/demo.git',
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-token')));
  await expect(
    service.mergeChecks('project', 'connection', '12'),
  ).rejects.toThrow('GitHub is unavailable');
});
