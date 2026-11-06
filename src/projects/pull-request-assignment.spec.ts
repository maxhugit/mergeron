import { expect, it, vi } from 'vitest';
import { WorkspaceGitService } from './workspace-git.service';
import type { WorkspaceCopiesService } from './workspace-copies.service';
import type { WorkspaceResourcesService } from './workspace-resources.service';
import type { PullRequestTrackerService } from './pull-request-tracker.service';
import { accessContext } from '../auth/access-context';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';

function fixture(accessMode = 'read_write') {
  const assign = vi.fn();
  const service = new WorkspaceGitService(
    {} as WorkspaceCopiesService,
    {
      resolveForTransfer: () => ({
        resource: {
          enabled: true,
          type: 'git',
          accessMode,
          address: 'https://github.com/o/r.git',
        },
      }),
    } as unknown as WorkspaceResourcesService,
    { assign } as unknown as PullRequestTrackerService,
  );
  const remote = vi
    .spyOn(service, 'pullRequest')
    .mockResolvedValue({ number: 12, state: 'open' } as Awaited<
      ReturnType<WorkspaceGitService['pullRequest']>
    >);
  return { service, assign, remote };
}
it('checks the real open PR and resource before recording a manual association', async () => {
  const { service, assign, remote } = fixture();
  await service.assignPullRequestAgent('p', 'r', '12', {
    threadId: 'a',
    phase: 'working',
    creator: true,
  });
  expect(remote).toHaveBeenCalledWith('p', 'r', '12');
  expect(assign).toHaveBeenCalledWith('p', 'o/r', 12, 'a');
  remote.mockResolvedValueOnce({ number: 12, state: 'closed' } as Awaited<
    ReturnType<WorkspaceGitService['pullRequest']>
  >);
  await expect(
    service.assignPullRequestAgent('p', 'r', '12', { threadId: 'a' }),
  ).rejects.toThrow('PR_NOT_OPEN');
  expect(assign).toHaveBeenCalledTimes(1);
});
it('rejects read-only, malformed input and unauthorized callers before mutation', async () => {
  const { service, assign, remote } = fixture('read_only');
  await expect(
    service.assignPullRequestAgent('p', 'r', '12', { threadId: 'a' }),
  ).rejects.toThrow('GIT_READ_ONLY');
  expect(assign).not.toHaveBeenCalled();
  expect(remote).not.toHaveBeenCalled();
  const other = fixture();
  await expect(
    other.service.assignPullRequestAgent('p', 'r', '12', {}),
  ).rejects.toThrow('PR_AGENT_UNAVAILABLE');
  const context = {
    identity: {} as PlatformIdentity,
    identities: {
      requireAdministrator: () => {
        throw new Error('denied');
      },
    } as unknown as IdentityService,
  };
  await expect(
    accessContext.run(context, () =>
      other.service.assignPullRequestAgent('p', 'r', '12', { threadId: 'a' }),
    ),
  ).rejects.toThrow('denied');
  expect(other.assign).not.toHaveBeenCalled();
});
