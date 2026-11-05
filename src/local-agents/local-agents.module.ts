import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SettingsModule } from '../settings/settings.module';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentsController } from './local-agents.controller';
@Module({
  imports: [DatabaseModule, SettingsModule],
  providers: [LocalAgentsService],
  controllers: [LocalAgentsController],
  exports: [LocalAgentsService],
})
export class LocalAgentsModule {}
