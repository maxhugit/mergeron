import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ActiveFoldersModule } from '../active-folders/active-folders.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { ProjectPreviewsService } from './project-previews.service';
import { PreviewManagerClient } from './preview-manager-client';
import { PreviewsController } from './previews.controller';
@Module({
  imports: [DatabaseModule, ActiveFoldersModule, ConfigModule, AuthModule],
  providers: [
    ProjectPreviewsService,
    PreviewManagerClient,
    {
      provide: 'PROJECT_PREVIEW_AGENT_TOOLS',
      useExisting: ProjectPreviewsService,
    },
  ],
  controllers: [PreviewsController],
  exports: [ProjectPreviewsService, PreviewManagerClient],
})
export class PreviewsModule {}
