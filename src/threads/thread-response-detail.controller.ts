import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
} from '@nestjs/common';
import {
  requireExecutionAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import {
  RESPONSE_DETAILS,
  ThreadResponseDetailService,
  type ResponseDetail,
} from './thread-response-detail.service';

@Controller('threads')
export class ThreadResponseDetailController {
  constructor(
    private readonly detail: ThreadResponseDetailService,
    private readonly deletion: ThreadDeletionRegistryService,
  ) {}

  @Get(':threadId/response-detail')
  read(@Param('threadId') threadId: string) {
    requireThreadAccess(threadId);
    return this.detail.read(threadId);
  }

  @Patch(':threadId/response-detail')
  set(@Param('threadId') threadId: string, @Body() body: { mode?: unknown }) {
    requireThreadAccess(threadId);
    requireExecutionAccess();
    this.deletion.assertMutable(threadId);
    if (!RESPONSE_DETAILS.includes(body?.mode as ResponseDetail)) {
      throw new BadRequestException('Choose hidden, collapsed or expanded.');
    }
    return this.detail.set(threadId, body.mode as ResponseDetail);
  }
}
