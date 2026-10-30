import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import { WorkspaceGitService } from './workspace-git.service';
import { WorkspaceCopiesService } from './workspace-copies.service';

@Controller(['projects/:projectId/workspace-git', 'projects/:projectId/git'])
export class WorkspaceGitController {
  constructor(
    private readonly git: WorkspaceGitService,
    private readonly actions: WorkspaceGitActionsService,
    private readonly copies: WorkspaceCopiesService,
  ) {}

  @Post('copies/:copyId/stage-review')
  stageReview(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.stageReview(projectId, copyId, body);
  }
  @Post('copies/:copyId/stage')
  stage(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.stage(projectId, copyId, body);
  }
  @Post('copies/:copyId/unstage')
  unstage(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.unstage(projectId, copyId, body);
  }

  @Post('copies/:copyId/release-owner')
  releaseOwner(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.copies.releaseOwner(projectId, copyId, body);
  }

  @Post('copies/:copyId/branches')
  createBranch(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.createBranch(projectId, copyId, body);
  }

  @Post('copies/:copyId/retrieve-branch')
  retrieveBranch(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.retrieveBranch(projectId, copyId, body);
  }

  @Post('copies/:copyId/branch-action')
  localBranchAction(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.localBranchAction(projectId, copyId, body);
  }

  @Post('copies/:copyId/integrate')
  integrateBranch(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.integrateBranch(projectId, copyId, body);
  }

  @Post('copies/:copyId/commit')
  commit(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.commit(projectId, copyId, body);
  }

  @Post('copies/:copyId/push')
  push(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.push(projectId, copyId, body);
  }

  @Post([
    'connections/:resourceId/pull-requests',
    'resources/:resourceId/pull-requests',
  ])
  createRemotePullRequest(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.createRemotePullRequest(projectId, resourceId, body);
  }

  @Post('copies/:copyId/pull-requests')
  createPullRequest(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.createPullRequest(projectId, copyId, body);
  }

  @Post([
    'resources/:resourceId/pull-requests/:number/merge',
    'connections/:resourceId/pull-requests/:number/merge',
  ])
  merge(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
    @Param('number') number: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.actions.merge(projectId, resourceId, number, body);
  }

  @Get('copies/:copyId')
  snapshot(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
  ) {
    return this.git.snapshot(projectId, copyId);
  }

  @Get('copies/:copyId/diff')
  diff(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Query('path') path: unknown,
  ) {
    return this.git.diff(projectId, copyId, path);
  }

  @Get('copies/:copyId/commits')
  commits(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
  ) {
    return this.git.commits(projectId, copyId);
  }

  @Get('copies/:copyId/graph')
  graph(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
  ) {
    return this.git.graph(projectId, copyId);
  }

  @Get(['resources/:resourceId/branches', 'connections/:resourceId/branches'])
  remoteBranches(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.git.remoteBranches(projectId, resourceId);
  }

  @Get('connections/:resourceId/graph')
  remoteGraph(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.git.remoteGraph(projectId, resourceId);
  }

  @Get('connections/:resourceId/files')
  remoteFiles(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
    @Query('path') filePath: unknown,
    @Query('ref') ref: unknown,
  ) {
    return this.git.remoteFiles(projectId, resourceId, filePath, ref);
  }

  @Get('copies/:copyId/staged-diff')
  stagedDiff(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Query('path') path?: unknown,
  ) {
    return this.git.stagedDiff(projectId, copyId, path);
  }

  @Get([
    'resources/:resourceId/pull-requests',
    'connections/:resourceId/pull-requests',
  ])
  pullRequests(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.git.pullRequests(projectId, resourceId);
  }

  @Get([
    'resources/:resourceId/pull-requests/:number/checks',
    'connections/:resourceId/pull-requests/:number/checks',
  ])
  checks(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
    @Param('number') number: string,
  ) {
    return this.git.checks(projectId, resourceId, number);
  }
}
