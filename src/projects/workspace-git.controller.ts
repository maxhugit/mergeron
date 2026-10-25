import { Controller, Get, Param, Query } from '@nestjs/common';
import { WorkspaceGitService } from './workspace-git.service';

@Controller('projects/:projectId/workspace-git')
export class WorkspaceGitController {
  constructor(private readonly git: WorkspaceGitService) {}

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
