import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceGitService } from './workspace-git.service';
import type { WorkspaceCopiesService } from './workspace-copies.service';
import type { WorkspaceResourcesService } from './workspace-resources.service';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('shares bounded checks only after resolving access and distinguishes tokens', async () => {
  let token = 'first';
  const resolveForTransfer = vi.fn(() => ({
    resource: {
      enabled: true,
      type: 'git',
      address: 'https://github.com/example/repo.git',
    },
    secret: { token },
  }));
  const service = new WorkspaceGitService(
    {} as WorkspaceCopiesService,
    { resolveForTransfer } as unknown as WorkspaceResourcesService,
  );
  const fetch = vi.fn((url: string) => ({
    ok: true,
    json: () =>
      Promise.resolve(
        url.endsWith('/pulls/12')
          ? {
              head: { sha: 'a'.repeat(40) },
              base: { sha: 'b'.repeat(40) },
              mergeable: true,
              mergeable_state: 'clean',
              draft: false,
            }
          : { total_count: 0, check_runs: [], statuses: [] },
      ),
  }));
  vi.stubGlobal('fetch', fetch);
  await Promise.all([
    service.checks('p', 'r', '12'),
    service.checks('p', 'r', '12'),
  ]);
  expect(fetch).toHaveBeenCalledTimes(3);
  await service.checks('p', 'r', '12', true);
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(resolveForTransfer.mock.calls.length).toBeGreaterThan(1);
  token = 'other';
  await service.checks('p', 'r', '12');
  expect(fetch).toHaveBeenCalledTimes(9);
  resolveForTransfer.mockImplementation(() => {
    throw new Error('access revoked');
  });
  await expect(service.checks('p', 'r', '12')).rejects.toThrow(
    'access revoked',
  );
});
it('drops failed observations instead of caching an unavailable state as success', async () => {
  const service = new WorkspaceGitService(
    {} as WorkspaceCopiesService,
    {
      resolveForTransfer: () => ({
        resource: {
          enabled: true,
          type: 'git',
          address: 'https://github.com/example/repo.git',
        },
      }),
    } as unknown as WorkspaceResourcesService,
  );
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetch);
  await expect(service.checks('p', 'r', '12')).rejects.toThrow();
  await expect(service.checks('p', 'r', '12')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});
