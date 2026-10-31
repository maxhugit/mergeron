import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import {
  requireExecutionAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadExecutionPreferencesService } from './thread-execution-preferences.service';

@Controller('threads')
export class ThreadExecutionPreferencesController {
  constructor(
    private readonly preferences: ThreadExecutionPreferencesService,
    private readonly deletion: ThreadDeletionRegistryService,
  ) {}
  @Get(':threadId/execution-preferences')
  read(@Param('threadId') threadId: string) {
    requireThreadAccess(threadId);
    return this.preferences.read(threadId);
  }
  @Patch(':threadId/execution-preferences')
  set(@Param('threadId') threadId: string, @Body() body: unknown) {
    requireThreadAccess(threadId);
    requireExecutionAccess();
    this.deletion.assertMutable(threadId);
    return this.preferences.set(threadId, body);
  }
}
