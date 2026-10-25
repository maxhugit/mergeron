import { Module } from '@nestjs/common';
import { CodexCliController } from './cli/codex-cli.controller';
import { CodexCliService } from './cli/codex-cli.service';
import { CodexConfigController } from './codex-config.controller';
import { CodexFeedbackController } from './codex-feedback.controller';
import { CodexProcessManager } from './codex-process-manager.service';
import { CodexStatusController } from './codex-status.controller';
import { CodexStatusService } from './codex-status.service';
import { CodexService } from './codex.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogPathsService } from './catalog/catalog-paths.service';
import { CatalogStorageService } from './catalog/catalog-storage.service';
import { CatalogNativeService } from './catalog/catalog-native.service';
import {
  CatalogAdmissionService,
  CatalogMutationInterceptor,
} from './catalog/catalog-admission.service';
import { CatalogActivityService } from './catalog/catalog-activity.service';
import { CatalogService } from './catalog/catalog.service';
import { SettingsModule } from '../settings/settings.module';
import { DocumentProtectionModule } from '../document-publication/document-protection.module';

@Module({
  imports: [SettingsModule, DocumentProtectionModule],
  controllers: [
    CodexCliController,
    CodexStatusController,
    CodexConfigController,
    CodexFeedbackController,
    CatalogController,
  ],
  providers: [
    CodexCliService,
    CodexProcessManager,
    CodexService,
    CodexStatusService,
    CatalogPathsService,
    CatalogStorageService,
    CatalogNativeService,
    CatalogAdmissionService,
    CatalogActivityService,
    CatalogService,
    { provide: APP_INTERCEPTOR, useClass: CatalogMutationInterceptor },
  ],
  exports: [
    CodexProcessManager,
    CodexService,
    CodexStatusService,
    CatalogAdmissionService,
  ],
})
export class CodexModule {}
