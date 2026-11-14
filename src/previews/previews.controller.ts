import { PreviewDiagnosticsDto } from './preview-diagnostics.dto';
import { Controller, Get, Put, Post, Param, Body, Query } from '@nestjs/common';
import { ProjectPreviewsService } from './project-previews.service';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiOkResponse,
} from '@nestjs/swagger';
import { PreviewVerificationOpenDto } from './preview-verification.dto';
@Controller('projects/:projectId')
export class PreviewsController {
  constructor(private readonly previews: ProjectPreviewsService) {}
  @Get('agents/:threadId/preview/source') source(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.sourceSettings(p, t);
  }
  @Put('agents/:threadId/preview/source') selectSource(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body() input: Record<string, unknown>,
  ) {
    return this.previews.selectSource(p, t, input);
  }
  @Get('test-environment') settings(@Param('projectId') p: string) {
    return this.previews.settings(p);
  }
  @Put('test-environment') save(
    @Param('projectId') p: string,
    @Body() input: { profile?: unknown; expectedRevision?: unknown },
  ) {
    return this.previews.saveSettings(p, input);
  }
  @Get('test-environment/recipes') preparedAgents(
    @Param('projectId') p: string,
  ) {
    return this.previews.preparedAgents(p);
  }
  @Get('agents/:threadId/preview/recipe') recipe(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.launchConfiguration(p, t);
  }
  @Put('agents/:threadId/preview/recipe') saveRecipe(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body() input: Record<string, unknown>,
  ) {
    return this.previews.saveAgentRecipe(p, t, input);
  }
  @Get('agents/:threadId/preview') status(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.status(p, t);
  }
  @Get('agents/:threadId/preview/diagnostics')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Read preview execution and termination diagnostics without executing project commands',
  })
  @ApiOkResponse({ type: PreviewDiagnosticsDto })
  diagnostics(@Param('projectId') p: string, @Param('threadId') t: string) {
    return this.previews.diagnostics(p, t);
  }
  @Get('agents/:threadId/preview/prerequisites') prerequisites(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.discovery(p, t);
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
    @Body()
    input: {
      requestId?: unknown;
      lifetimeMinutes?: unknown;
      expectedRevision?: unknown;
    },
  ) {
    return this.previews.start(
      p,
      t,
      input.requestId,
      false,
      () => {},
      input.lifetimeMinutes,
      input.expectedRevision,
    );
  }
  @Get('agents/:threadId/preview/containers') containers(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ) {
    return this.previews.inspectRuntime(p, t, 'containers');
  }
  @Get('agents/:threadId/preview/container-logs') containerLogs(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Query('component') component: string,
  ) {
    return this.previews.inspectRuntime(p, t, 'container-logs', { component });
  }
  @Post('agents/:threadId/preview/terminal') terminal(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body() input: Record<string, unknown>,
  ) {
    return this.previews.inspectRuntime(p, t, 'terminal', input);
  }
  @Post('agents/:threadId/preview/refresh') refresh(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body()
    input: {
      requestId?: unknown;
      lifetimeMinutes?: unknown;
      expectedRevision?: unknown;
    },
  ) {
    return this.previews.start(
      p,
      t,
      input.requestId,
      true,
      () => {},
      input.lifetimeMinutes,
      input.expectedRevision,
    );
  }
  @Put('agents/:threadId/preview/lifetime') lifetime(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
    @Body()
    input: {
      requestId?: unknown;
      lifetimeMinutes?: unknown;
    },
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
  @Post('agents/:threadId/preview/verify')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open the authorized browser preview diagnostic' })
  @ApiCreatedResponse({ type: PreviewVerificationOpenDto })
  verify(
    @Param('projectId') p: string,
    @Param('threadId') t: string,
  ): Promise<PreviewVerificationOpenDto> {
    return this.previews.open(p, t, true);
  }
}
