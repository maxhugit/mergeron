/** Pending approval persistence module. */
import { Module } from '@nestjs/common';
import { ThreadExecutionPreferencesModule } from '../threads/thread-execution-preferences.module';
import { CodexModule } from '../codex/codex.module';
import { DatabaseModule } from '../database/database.module';
import { ThreadDeletionModule } from '../thread-deletion/thread-deletion.module';
import { PendingApprovalsController } from './pending-approvals.controller';
import { PendingApprovalsService } from './pending-approvals.service';

@Module({
  imports: [
    CodexModule,
    DatabaseModule,
    ThreadDeletionModule,
    ThreadExecutionPreferencesModule,
  ],
  controllers: [PendingApprovalsController],
  providers: [PendingApprovalsService],
  exports: [PendingApprovalsService],
})
export class PendingApprovalsModule {}
