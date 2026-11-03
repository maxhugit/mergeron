import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CodexModule } from '../codex/codex.module';
import { DatabaseModule } from '../database/database.module';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamObserver } from './agent-team-observer.service';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamsController } from './agent-teams.controller';

@Module({
  imports: [DatabaseModule, AuthModule, CodexModule],
  providers: [AgentTeamStore, AgentTeamObserver, AgentTeamsService],
  controllers: [AgentTeamsController],
})
export class AgentTeamsModule {}
