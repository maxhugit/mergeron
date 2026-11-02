import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { SettingsModule } from '../settings/settings.module';
import { OnlyOfficeController } from './onlyoffice.controller';
import { AuthModule } from '../auth/auth.module';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { DatabaseModule } from '../database/database.module';
import { ThreadsModule } from '../threads/threads.module';
import { OnlyOfficeAssistantService } from './onlyoffice-assistant.service';
import { OnlyOfficeAssistantController } from './onlyoffice-assistant.controller';

@Module({
  imports: [
    FilesModule,
    SettingsModule,
    AuthModule,
    DeliverablesModule,
    DatabaseModule,
    ThreadsModule,
  ],
  controllers: [OnlyOfficeController, OnlyOfficeAssistantController],
  providers: [OnlyOfficeAssistantService],
})
export class OnlyOfficeModule {}
