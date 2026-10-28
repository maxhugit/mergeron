import { Module } from '@nestjs/common';
import { ProjectKnowledgeModule } from '../project-knowledge/project-knowledge.module';
import { CodexModule } from '../codex/codex.module';
import { InternalMcpService } from './internal-mcp.service';
import { InternalMcpController } from './internal-mcp.controller';
import { BrowserModule } from '../browser/browser.module';

@Module({
  imports: [ProjectKnowledgeModule, CodexModule, BrowserModule],
  providers: [InternalMcpService],
  controllers: [InternalMcpController],
  exports: [InternalMcpService],
})
export class InternalMcpModule {}
