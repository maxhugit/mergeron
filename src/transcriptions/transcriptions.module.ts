import { DeliverablesModule } from '../deliverables/deliverables.module';
import { ProjectMediaToolsService } from './project-media-tools.service';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SettingsModule } from '../settings/settings.module';
import { TranscriptionsController } from './transcriptions.controller';
import { TranscriptionsService } from './transcriptions.service';
@Module({
  imports: [DatabaseModule, SettingsModule, DeliverablesModule],
  controllers: [TranscriptionsController],
  providers: [
    TranscriptionsService,
    ProjectMediaToolsService,
    {
      provide: 'PROJECT_MEDIA_AGENT_TOOLS',
      useExisting: ProjectMediaToolsService,
    },
  ],
})
export class TranscriptionsModule {}
