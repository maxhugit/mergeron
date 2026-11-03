/** Projects native collaboration evidence; never dispatches or replays work. */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { AgentTeamStore, type AssignmentStatus } from './agent-team-store';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const statuses: Record<string, AssignmentStatus> = {
  pendingInit: 'unknown',
  running: 'running',
  completed: 'completed',
  errored: 'failed',
  interrupted: 'cancelled',
  shutdown: 'cancelled',
  notFound: 'unknown',
};

@Injectable()
export class AgentTeamObserver implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTeamObserver.name);
  private stopped = false;
  private readonly releaseLifecycle: () => void;
  constructor(
    private readonly store: AgentTeamStore,
    manager: CodexProcessManager,
  ) {
    manager.addListener('notification', (note) => this.observe(note));
    this.releaseLifecycle = manager.addLifecycleListener((event) => {
      if (this.stopped) return;
      if (
        event.type === 'appServerRestarting' ||
        event.type === 'appServerUnavailable'
      )
        this.store.markUncertain();
    });
  }
  onModuleInit() {
    this.store.markUncertain();
  }
  onModuleDestroy() {
    this.stopped = true;
    this.releaseLifecycle();
  }

  observe(value: unknown) {
    if (this.stopped) return;
    try {
      const note = record(value),
        params = record(note.params),
        item = record(params.item);
      const threadId = string(params.threadId);
      if (!threadId) return;
      if (
        note.method === 'item/completed' &&
        item.type === 'collabAgentToolCall' &&
        item.senderThreadId === threadId
      ) {
        if (
          item.tool === 'spawnAgent' &&
          item.status === 'completed' &&
          Array.isArray(item.receiverThreadIds)
        ) {
          for (const childId of item.receiverThreadIds.slice(0, 12)) {
            if (typeof childId === 'string' && childId.length <= 128)
              this.store.discoverSpawn(
                threadId,
                string(params.turnId),
                childId,
                string(item.prompt),
              );
          }
        }
        for (const [childId, raw] of Object.entries(
          record(item.agentsStates),
        )) {
          const owner = this.store.child(childId);
          if (!owner || owner.coordinatorThreadId !== threadId) continue;
          const state = record(raw),
            status = statuses[string(state.status)];
          if (status)
            this.store.observe(
              owner.projectId,
              owner.teamId,
              childId,
              status,
              typeof state.message === 'string'
                ? state.message.slice(0, 100000)
                : null,
            );
        }
      }
      const owner = this.store.child(threadId);
      if (!owner) return;
      if (
        note.method === 'item/completed' &&
        item.type === 'agentMessage' &&
        (item.phase === 'final_answer' || item.phase === null)
      )
        this.store.saveResult(threadId, string(item.text));
      if (note.method === 'turn/started')
        this.store.observe(owner.projectId, owner.teamId, threadId, 'running');
      if (note.method === 'turn/completed') {
        const status = {
          completed: 'completed',
          interrupted: 'cancelled',
          failed: 'failed',
        }[string(record(params.turn).status)] as AssignmentStatus | undefined;
        if (status)
          this.store.observe(owner.projectId, owner.teamId, threadId, status);
      }
    } catch (error) {
      // No prompt, result, or transport payload goes to operator logs.
      this.logger.warn(
        `Team observation rejected: ${error instanceof Error ? error.name : 'invalid evidence'}`,
      );
    }
  }
}
