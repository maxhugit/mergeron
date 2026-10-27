import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { WorkspaceGitController } from './workspace-git.controller';
import type { WorkspaceGitService } from './workspace-git.service';
import type { WorkspaceGitActionsService } from './workspace-git-actions.service';

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
