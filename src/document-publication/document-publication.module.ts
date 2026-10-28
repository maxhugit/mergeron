import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CodexModule } from '../codex/codex.module';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { DocumentProtectionModule } from './document-protection.module';
import { DocumentPublicationService } from './document-publication.service';
import { ProjectKnowledgeModule } from '../project-knowledge/project-knowledge.module';

@Module({
  imports: [
    ProjectKnowledgeModule,
    DatabaseModule,
    CodexModule,
    DeliverablesModule,
    DocumentProtectionModule,
  ],
  providers: [DocumentPublicationService],
  exports: [DocumentPublicationService],
})
export class DocumentPublicationModule {}
