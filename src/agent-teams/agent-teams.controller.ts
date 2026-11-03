import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { AgentTeamsService } from './agent-teams.service';

@Controller('projects/:projectId/agent-teams')
export class AgentTeamsController {
  constructor(private readonly teams: AgentTeamsService) {}
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
    return this.teams.read(req.platformIdentity!, projectId, teamId);
  }
}
