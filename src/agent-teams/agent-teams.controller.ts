import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamControlsService } from './agent-team-controls.service';

@Controller('projects/:projectId/agent-teams')
export class AgentTeamsController {
  constructor(
    private readonly teams: AgentTeamsService,
    private readonly controls: AgentTeamControlsService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Query('coordinator') coordinator: string,
  ) {
    return this.teams.list(req.platformIdentity!, projectId, coordinator);
  }
  @Get(':teamId')
  @Header('Cache-Control', 'no-store')
  read(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
  ) {
    return this.controls.details(req.platformIdentity!, projectId, teamId);
  }
  @Get(':teamId/assignments/:assignmentId/history')
  @Header('Cache-Control', 'no-store')
  history(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
    @Param('assignmentId') assignmentId: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.controls.messages(
      req.platformIdentity!,
      projectId,
      teamId,
      assignmentId,
      cursor,
    );
  }
  @Post(':teamId/reconcile')
  @HttpCode(200)
  reconcile(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
  ) {
    return this.controls.reconcile(req.platformIdentity!, projectId, teamId);
  }
  @Post(':teamId/stop')
  @HttpCode(200)
  stop(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
  ) {
    return this.controls.stop(req.platformIdentity!, projectId, teamId);
  }
}
