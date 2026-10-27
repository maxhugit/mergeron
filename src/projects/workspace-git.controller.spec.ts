import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { WorkspaceGitController } from './workspace-git.controller';
import type { WorkspaceGitService } from './workspace-git.service';
import type { WorkspaceGitActionsService } from './workspace-git-actions.service';
import type { WorkspaceCopiesService } from './workspace-copies.service';

it('routes confirmed remote retrieval through the mutation service', async () => {
  const retrieveBranch = vi.fn().mockResolvedValue({ branch: 'dev' });
  const controller = new WorkspaceGitController(
    {} as WorkspaceGitService,
    { retrieveBranch } as unknown as WorkspaceGitActionsService,
    {} as WorkspaceCopiesService,
  );
  const body = { confirmation: 'RETRIEVE_REMOTE_BRANCH', name: 'dev' };
  await controller.retrieveBranch('p', 'copy', body);
  expect(retrieveBranch).toHaveBeenCalledWith('p', 'copy', body);
  expect(
    Reflect.getMetadata(
      PATH_METADATA,
      Object.getOwnPropertyDescriptor(
        WorkspaceGitController.prototype,
        'retrieveBranch',
      )!.value as object,
    ),
  ).toBe('copies/:copyId/retrieve-branch');
});

it('routes explicit PR creation to the action service', async () => {
  const createPullRequest = vi.fn().mockResolvedValue({ number: 12 });
  const controller = new WorkspaceGitController(
    {} as WorkspaceGitService,
    { createPullRequest } as unknown as WorkspaceGitActionsService,
    {} as WorkspaceCopiesService,
  );
  const body = { confirmation: 'CREATE_PULL_REQUEST' };
  await controller.createPullRequest('p', 'copy', body);
  expect(createPullRequest).toHaveBeenCalledWith('p', 'copy', body);
});

it('routes local branch actions through the protected action service', async () => {
  const localBranchAction = vi.fn();
  const controller = new WorkspaceGitController(
    {} as WorkspaceGitService,
    { localBranchAction } as unknown as WorkspaceGitActionsService,
    {} as WorkspaceCopiesService,
  );
  const body = { action: 'switch', confirmation: 'LOCAL_BRANCH_ACTION' };
  await controller.localBranchAction('p', 'copy', body);
  expect(localBranchAction).toHaveBeenCalledWith('p', 'copy', body);
  expect(
    Reflect.getMetadata(
      PATH_METADATA,
      Object.getOwnPropertyDescriptor(
        WorkspaceGitController.prototype,
        'localBranchAction',
      )!.value as object,
    ),
  ).toBe('copies/:copyId/branch-action');
});

it('routes confirmed local branch creation to the action service', async () => {
  const createBranch = vi.fn().mockResolvedValue({ branch: 'feature/test' });
  const controller = new WorkspaceGitController(
    {} as WorkspaceGitService,
    { createBranch } as unknown as WorkspaceGitActionsService,
    {} as WorkspaceCopiesService,
  );
  const body = { name: 'feature/test', confirmation: 'CREATE_LOCAL_BRANCH' };
  await controller.createBranch('p', 'copy', body);
  expect(createBranch).toHaveBeenCalledWith('p', 'copy', body);
  expect(
    Reflect.getMetadata(
      PATH_METADATA,
      Object.getOwnPropertyDescriptor(
        WorkspaceGitController.prototype,
        'createBranch',
      )!.value as object,
    ),
  ).toBe('copies/:copyId/branches');
});

it('exposes remote branch inspection at the canonical connections path and the legacy path', async () => {
  const remoteBranches = vi.fn().mockResolvedValue({
    supported: true,
    items: [],
    limited: false,
    inspectedAt: 1,
  });
  const controller = new WorkspaceGitController(
    { remoteBranches } as unknown as WorkspaceGitService,
    {} as WorkspaceGitActionsService,
    {} as WorkspaceCopiesService,
  );
  const handler = Object.getOwnPropertyDescriptor(
    WorkspaceGitController.prototype,
    'remoteBranches',
  )!.value as object;
  expect(Reflect.getMetadata(PATH_METADATA, WorkspaceGitController)).toContain(
    'projects/:projectId/git',
  );
  expect(Reflect.getMetadata(PATH_METADATA, handler)).toEqual([
    'resources/:resourceId/branches',
    'connections/:resourceId/branches',
  ]);
  expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  await expect(
    controller.remoteBranches('project', 'connection'),
  ).resolves.toEqual({
    supported: true,
    items: [],
    limited: false,
    inspectedAt: 1,
  });
  expect(remoteBranches).toHaveBeenCalledWith('project', 'connection');
});
