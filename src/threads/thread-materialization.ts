import type { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { isUnmaterializedTurnsListError } from './thread-errors';

/** Positive Core evidence only: an empty persisted page is NOT an unmaterialized thread. */
export async function isUnmaterializedThread(
  codex: CodexService,
  threadId: string,
): Promise<boolean> {
  try {
    await codex.request<v2.ThreadTurnsListResponse>('thread/turns/list', {
      threadId,
      limit: 1,
    });
    return false;
  } catch (error) {
    if (isUnmaterializedTurnsListError(error)) return true;
    throw error;
  }
}
