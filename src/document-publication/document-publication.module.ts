import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CodexModule } from '../codex/codex.module';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { DocumentProtectionModule } from './document-protection.module';
import { DocumentPublicationService } from './document-publication.service';
import { LocalAgentsModule } from '../local-agents/local-agents.module';

@Module({
  imports: [
    LocalAgentsModule,
    DatabaseModule,
    CodexModule,
    DeliverablesModule,
    DocumentProtectionModule,
  ],
  providers: [DocumentPublicationService],
  exports: [DocumentPublicationService],
})
export class DocumentPublicationModule {}
