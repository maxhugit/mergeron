/** Observe native starts as well as the explicit HTTP creation paths. */
import { Injectable } from '@nestjs/common';
import { AgentProjectMembershipService } from '../active-folders/agent-project-membership.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';

@Injectable()
export class AgentProjectObserverService {
  constructor(
    manager: CodexProcessManager,
    memberships: AgentProjectMembershipService,
  ) {
    manager.addListener('notification', (note: ServerNotification) => {
      if (note.method === 'thread/started')
        memberships.observe(note.params.thread);
    });
  }
}
