import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import { WorkspaceGitService } from './workspace-git.service';

@Controller('projects/:projectId/workspace-git')
export class WorkspaceGitController {
  constructor(
    private readonly git: WorkspaceGitService,
    private readonly actions: WorkspaceGitActionsService,
  ) {}

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

  @Post('resources/:resourceId/pull-requests/:number/merge')
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

  @Get('copies/:copyId/staged-diff')
  stagedDiff(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
  ) {
    return this.git.stagedDiff(projectId, copyId);
  }

  @Get('resources/:resourceId/pull-requests')
  pullRequests(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.git.pullRequests(projectId, resourceId);
  }

  @Get('resources/:resourceId/pull-requests/:number/checks')
  checks(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
    @Param('number') number: string,
  ) {
    return this.git.checks(projectId, resourceId, number);
  }
}
