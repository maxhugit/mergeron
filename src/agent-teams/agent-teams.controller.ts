import { AgentTeamBusinessService } from './agent-team-business.service';
import {
  Body,
  Put,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { AgentTeamLaunchService } from './agent-team-launch.service';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamControlsService } from './agent-team-controls.service';

@Controller('projects/:projectId/agent-teams')
export class AgentTeamsController {
  constructor(
    private readonly teams: AgentTeamsService,
    private readonly controls: AgentTeamControlsService,
    private readonly launchService: AgentTeamLaunchService,
    private readonly business: AgentTeamBusinessService,
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
  @Get('profiles')
  @Header('Cache-Control', 'no-store')
  profiles(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Query('coordinator') coordinator: string,
  ) {
    return this.launchService.profiles(
      req.platformIdentity!,
      projectId,
      coordinator,
    );
  }
  @Put('profiles')
  profilesWrite(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Query('coordinator') coordinator: string,
    @Body() body: unknown,
  ) {
    return this.launchService.saveProfiles(
      req.platformIdentity!,
      projectId,
      coordinator,
      body,
    );
  }
  @Post('prepare')
  prepare(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Query('coordinator') coordinator: string,
    @Body() body: unknown,
  ) {
    return this.launchService.prepare(
      req.platformIdentity!,
      projectId,
      coordinator,
      body,
    );
  }
  @Post(':teamId/launch')
  @HttpCode(200)
  launch(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
  ) {
    return this.launchService.launch(req.platformIdentity!, projectId, teamId);
  }
  @Get('context')
  @Header('Cache-Control', 'no-store')
  context(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Query('coordinator') coordinator: string,
  ) {
    return this.business.context(req.platformIdentity!, projectId, coordinator);
  }
  @Get('contributions')
  @Header('Cache-Control', 'no-store')
  contributions(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Query('taskId') taskId?: string,
    @Query('deliverableId') deliverableId?: string,
  ) {
    return this.business.contributions(
      req.platformIdentity!,
      projectId,
      taskId,
      deliverableId,
    );
  }
  @Put(':teamId/links')
  links(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
  ) {
    return this.business.links(req.platformIdentity!, projectId, teamId, body);
  }
  @Post(':teamId/assignments/:assignmentId/task')
  createTask(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: unknown,
  ) {
    return this.business.createTask(
      req.platformIdentity!,
      projectId,
      teamId,
      assignmentId,
      body,
    );
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
