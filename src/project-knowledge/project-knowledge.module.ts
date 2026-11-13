import { AgentContextService } from './agent-context.service';
import { AgentContextController } from './agent-context.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ProjectKnowledgeService } from './project-knowledge.service';
import { KnowledgeProposalsService } from './knowledge-proposals.service';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { ProjectAgentToolsService } from './project-agent-tools.service';

@Module({
  imports: [DatabaseModule, DeliverablesModule],
  controllers: [AgentContextController],
  providers: [
    AgentContextService,
    ProjectKnowledgeService,
    KnowledgeProposalsService,
    ProjectAgentToolsService,
  ],
  exports: [
    AgentContextService,
    ProjectKnowledgeService,
    KnowledgeProposalsService,
    ProjectAgentToolsService,
  ],
})
export class ProjectKnowledgeModule {}
