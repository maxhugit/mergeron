import { Controller, Get, Put, Post, Param, Body } from '@nestjs/common';
import { ProjectPreviewsService } from './project-previews.service';
@Controller('projects/:projectId')
export class PreviewsController {
  constructor(private readonly previews: ProjectPreviewsService) {}
  @Get('test-environment') settings(@Param('projectId') p: string) {
    return this.previews.settings(p);
  }
  @Put('test-environment') save(
    @Param('projectId') p: string,
    @Body() input: { profile?: unknown; expectedRevision?: unknown },
  ) {
    return this.previews.saveSettings(p, input);
  }
  @Get('agents/:threadId/preview') status(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.status(p, t);
  }
  @Get('agents/:threadId/preview/logs') logs(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.logs(p, t);
  }
  @Post('agents/:threadId/preview/start') start(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body() input: { requestId?: unknown; lifetimeMinutes?: unknown },
  ) {
    return this.previews.start(
      p,
      t,
      input.requestId,
      false,
      () => {},
      input.lifetimeMinutes,
    );
  }
  @Post('agents/:threadId/preview/refresh') refresh(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body() input: { requestId?: unknown; lifetimeMinutes?: unknown },
  ) {
    return this.previews.start(
      p,
      t,
      input.requestId,
      true,
      () => {},
      input.lifetimeMinutes,
    );
  }
  @Put('agents/:threadId/preview/lifetime') lifetime(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body() input: { requestId?: unknown; lifetimeMinutes?: unknown },
  ) {
    return this.previews.setLifetime(p, t, input);
  }
  @Post('agents/:threadId/preview/stop') stop(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.stop(p, t);
  }
  @Post('agents/:threadId/preview/sync') sync(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.synchronize(p, t);
  }
  @Post('agents/:threadId/preview/open') open(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.open(p, t);
  }
}
