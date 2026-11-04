/** Shared durable choices, without a dependency on the thread execution module. */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LocalAgentsModule } from '../local-agents/local-agents.module';
import { ThreadExecutionPreferencesService } from './thread-execution-preferences.service';

@Module({
  imports: [DatabaseModule, LocalAgentsModule],
  providers: [ThreadExecutionPreferencesService],
  exports: [ThreadExecutionPreferencesService],
})
export class ThreadExecutionPreferencesModule {}
