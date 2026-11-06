import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { MockupsService } from './mockups.service';
@Controller('projects/:projectId/conversations/:threadId/mockups')
export class MockupsController {
  constructor(private readonly mockups: MockupsService) {}
  @Get() list(
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
  ) {
    return this.mockups.list(projectId, threadId);
  }
  @Get(':id') read(
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Param('id') id: string,
    @Query('revision') revision: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-store');
    return this.mockups.read(projectId, threadId, id, revision);
  }
}
