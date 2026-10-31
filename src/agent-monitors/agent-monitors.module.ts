import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { CodexModule } from '../codex/codex.module';
import { ThreadsModule } from '../threads/threads.module';
import { InternalMcpModule } from '../internal-mcp/internal-mcp.module';
import { PendingApprovalsModule } from '../pending-approvals/pending-approvals.module';
import { AgentMonitorStoreModule } from './agent-monitor-store.module';
import { AgentMonitorRuntime } from './agent-monitor-runtime.service';
import { AgentMonitorsService } from './agent-monitors.service';
import { AgentMonitorsController } from './agent-monitors.controller';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    CodexModule,
    ThreadsModule,
    InternalMcpModule,
    PendingApprovalsModule,
    AgentMonitorStoreModule,
  ],
  providers: [
    AgentMonitorRuntime,
    AgentMonitorsService,
    { provide: 'AGENT_MONITOR_TOOLS', useExisting: AgentMonitorsService },
  ],
  controllers: [AgentMonitorsController],
})
export class AgentMonitorsModule {}
