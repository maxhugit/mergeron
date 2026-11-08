import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CodexModule } from '../codex/codex.module';
import { PendingApprovalsModule } from '../pending-approvals/pending-approvals.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
@Module({
  imports: [AuthModule, DatabaseModule, CodexModule, PendingApprovalsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
