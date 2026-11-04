import { DocumentOrganizationService } from './document-organization.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { FilesModule } from '../files/files.module';
import { DeliverablesService } from './deliverables.service';
import { ActiveFoldersModule } from '../active-folders/active-folders.module';
@Module({
  imports: [ActiveFoldersModule, DatabaseModule, FilesModule, AuthModule],
  providers: [DeliverablesService, DocumentOrganizationService],
  exports: [DeliverablesService, DocumentOrganizationService],
})
export class DeliverablesModule {}
