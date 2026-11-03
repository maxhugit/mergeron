import { AgentTeamLaunchService } from './agent-team-launch.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CodexModule } from '../codex/codex.module';
import { DatabaseModule } from '../database/database.module';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamObserver } from './agent-team-observer.service';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamsController } from './agent-teams.controller';
import { ThreadsModule } from '../threads/threads.module';
import { PendingApprovalsModule } from '../pending-approvals/pending-approvals.module';
import { AgentTeamControlsService } from './agent-team-controls.service';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    CodexModule,
    ThreadsModule,
    PendingApprovalsModule,
  ],
  providers: [
    AgentTeamStore,
    AgentTeamObserver,
    AgentTeamsService,
    AgentTeamControlsService,
    AgentTeamLaunchService,
  ],
  controllers: [AgentTeamsController],
})
export class AgentTeamsModule {}
