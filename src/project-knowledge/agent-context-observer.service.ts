import { Injectable, Logger } from '@nestjs/common';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import { AgentContextService } from './agent-context.service';

/** Compaction invalidates the receipt; it does not claim a new transmission. */
@Injectable()
export class AgentContextObserverService {
  private readonly logger = new Logger(AgentContextObserverService.name);
  private readonly listener = (notification: ServerNotification) => {
    const method: string = notification.method;
    if (!['item/completed', 'thread/compacted'].includes(method)) return;
    const params = notification.params as {
      threadId?: string;
      item?: { type?: string };
    };
    if (
      (method === 'thread/compacted' ||
        params.item?.type === 'contextCompaction') &&
      params.threadId
    )
      try {
        this.context.invalidated(params.threadId, 'compaction');
      } catch {
        this.logger.warn(
          'Unable to invalidate instruction receipt after compaction',
        );
      }
  };
  constructor(
    private readonly manager: CodexProcessManager,
    private readonly context: AgentContextService,
  ) {
    manager.addListener('notification', this.listener);
    manager.addLifecycleListener((event) => {
      if (event.type === 'appServerReady') {
        try {
          this.context.invalidateSessions();
        } catch {
          this.logger.warn(
            'Unable to invalidate instruction receipts after runtime restart',
          );
        }
      }
    });
  }
}
