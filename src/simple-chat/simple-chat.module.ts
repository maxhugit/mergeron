import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { CodexAudioService } from './codex-audio.service';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { ProjectKnowledgeModule } from '../project-knowledge/project-knowledge.module';
import { DatabaseModule } from '../database/database.module';
import { FilesModule } from '../files/files.module';
import { SimpleChatController } from './simple-chat.controller';
import { SimpleChatService } from './simple-chat.service';
import { ThreadsModule } from '../threads/threads.module';
import { ActiveFoldersModule } from '../active-folders/active-folders.module';

@Module({
  imports: [
    CodexModule,
    ActiveFoldersModule,
    DatabaseModule,
    FilesModule,
    ThreadsModule,
    ProjectKnowledgeModule,
    DeliverablesModule,
  ],
  controllers: [SimpleChatController],
  providers: [SimpleChatService, CodexAudioService],
  exports: [SimpleChatService],
})
export class SimpleChatModule {}
