import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AgentMonitorStore } from './agent-monitor-store';

/** No timer or agent execution is installed by the storage foundation alone. */
@Module({
  imports: [DatabaseModule],
  providers: [AgentMonitorStore],
  exports: [AgentMonitorStore],
})
export class AgentMonitorStoreModule {}
