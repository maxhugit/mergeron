import { SettingsModule } from '../settings/settings.module';
import { AppCatalogService } from './app-catalog.service';
import { AppCatalogTransport } from './app-catalog-transport.service';
import { AppCatalogController } from './app-catalog.controller';
import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';

@Module({
  imports: [CodexModule, SettingsModule],
  controllers: [AppsController, AppCatalogController],
  providers: [AppsService, AppCatalogService, AppCatalogTransport],
  exports: [AppsService],
})
export class AppsModule {}
