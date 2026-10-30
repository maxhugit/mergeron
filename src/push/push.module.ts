import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CodexModule } from '../codex/codex.module';
import { PendingApprovalsModule } from '../pending-approvals/pending-approvals.module';
import { ThreadsModule } from '../threads/threads.module';
import { ThreadDeletionModule } from '../thread-deletion/thread-deletion.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PushTransportService } from './push-transport.service';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    CodexModule,
    PendingApprovalsModule,
    ThreadsModule,
    ThreadDeletionModule,
  ],
  controllers: [PushController],
  providers: [PushService, PushTransportService],
})
export class PushModule {}
