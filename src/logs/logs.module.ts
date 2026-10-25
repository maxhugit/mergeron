/** Logs module exposing structured log browsing and diagnostics export. */
import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';
import { SettingsModule } from '../settings/settings.module';
import { LogRetentionService } from './log-retention.service';

@Module({
  imports: [CodexModule, SettingsModule],
  controllers: [LogsController],
  providers: [LogsService, LogRetentionService],
})
export class LogsModule {}
