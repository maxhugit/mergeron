import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentProtectionService } from './document-protection.service';

@Module({
  imports: [DatabaseModule],
  providers: [DocumentProtectionService],
  exports: [DocumentProtectionService],
})
export class DocumentProtectionModule {}
