import { ConflictException, Injectable } from '@nestjs/common';
import { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';

/** Conservative server-wide gate: autonomous agents can access other copies. */
@Injectable()
export class GitMutationGateService {
  private writing = false;
  private starting = 0;
  constructor(
    private readonly inventory: ThreadExecutionInventoryService,
    private readonly manager: CodexProcessManager,
  ) {}
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.manager.getClient())
      throw new ConflictException('GIT_AGENT_STATE_UNKNOWN');
    if (this.writing || this.starting || this.inventory.snapshot().length)
      throw new ConflictException('GIT_BUSY');
    this.writing = true;
    try {
      return await operation();
    } finally {
      this.writing = false;
    }
  }
  async startTurn<T>(operation: () => Promise<T>): Promise<T> {
    if (this.writing) throw new ConflictException('GIT_BUSY');
    this.starting++;
    try {
      return await operation();
    } finally {
      this.starting--;
    }
  }
}
