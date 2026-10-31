import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Header,
} from '@nestjs/common';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { AgentMonitorsService } from './agent-monitors.service';

@Controller('projects/:projectId/agent-monitors')
export class AgentMonitorsController {
  constructor(private readonly monitors: AgentMonitorsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: IdentityRequest, @Param('projectId') projectId: string) {
    return this.monitors.list(req.platformIdentity!, projectId);
  }
  @Get(':monitorId')
  @Header('Cache-Control', 'no-store')
  read(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('monitorId') id: string,
  ) {
    return this.monitors.read(req.platformIdentity!, projectId, id);
  }
  @Post()
  create(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.monitors.create(req.platformIdentity!, projectId, body);
  }
  @Post(':monitorId/pause')
  pause(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('monitorId') id: string,
  ) {
    return this.monitors.pause(req.platformIdentity!, projectId, id);
  }
  @Post(':monitorId/resume')
  resume(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('monitorId') id: string,
  ) {
    return this.monitors.resume(req.platformIdentity!, projectId, id);
  }
  @Post(':monitorId/stop')
  stop(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('monitorId') id: string,
  ) {
    return this.monitors.stop(req.platformIdentity!, projectId, id);
  }
  @Delete(':monitorId')
  remove(
    @Req() req: IdentityRequest,
    @Param('projectId') projectId: string,
    @Param('monitorId') id: string,
  ) {
    return this.monitors.remove(req.platformIdentity!, projectId, id);
  }
}
