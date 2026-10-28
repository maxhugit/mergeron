/** Runtime settings module backed by SQLite. */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ServerReleaseService } from './server-release.service';
import { ManagerStatusService } from './manager-status.service';
import { ImageUpdateService } from './image-update.service';
import { AgentInstructionsService } from './agent-instructions.service';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    AgentInstructionsService,
    ServerReleaseService,
    ManagerStatusService,
    ImageUpdateService,
  ],
  exports: [
    SettingsService,
    AgentInstructionsService,
    ServerReleaseService,
    ManagerStatusService,
  ],
})
export class SettingsModule {}
