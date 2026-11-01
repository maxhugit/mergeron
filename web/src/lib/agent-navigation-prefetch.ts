/** Read-only, bounded warm-up. Never resumes an agent or claims writer ownership. */
import type { QueryClient } from '@tanstack/react-query';
import { threadsListTurns, threadsReadThread } from '@/generated/api/sdk.gen';
import { HISTORY_PAGE_SIZE } from './history-prefetch';
import { assertFullHistoryPage } from './full-history';
import type {
  ThreadReadResponseDto,
  ThreadTurnsPageDto,
} from '@/generated/api/types.gen';

export const agentSnapshotKey = (
  owner: string,
  projectId: string,
  threadId: string,
) => ['agent-navigation-snapshot', owner, projectId, threadId] as const;
export interface AgentNavigationSnapshot {
  metadata: ThreadReadResponseDto;
  page: ThreadTurnsPageDto;
}
export const AGENT_SNAPSHOT_MAX_AGE_MS = 60_000;

export async function prefetchAgentNavigation(
  client: QueryClient,
  owner: string,
  projectId: string,
  threadIds: readonly string[],
  signal: AbortSignal,
  current: () => boolean,
) {
  for (const threadId of threadIds.slice(0, 4)) {
    if (signal.aborted || !current()) return;
    try {
      await client.fetchQuery({
        queryKey: agentSnapshotKey(owner, projectId, threadId),
        staleTime: AGENT_SNAPSHOT_MAX_AGE_MS,
        gcTime: AGENT_SNAPSHOT_MAX_AGE_MS,
        retry: false,
        queryFn: async () => {
          const metadata = await threadsReadThread({
            path: { threadId },
            signal,
            meta: { silent: true },
            throwOnError: true,
          });
          if (metadata.data.thread.id !== threadId)
            throw new Error('Conversation identity mismatch');
          if (signal.aborted || !current())
            throw new DOMException('Cancelled', 'AbortError');
          const page = await threadsListTurns({
            path: { threadId },
            query: {
              limit: HISTORY_PAGE_SIZE,
              sortDirection: 'desc',
              itemsView: 'full',
            },
            signal,
            meta: { silent: true },
            throwOnError: true,
          });
          assertFullHistoryPage(page.data);
          if (signal.aborted || !current())
            throw new DOMException('Cancelled', 'AbortError');
          return {
            metadata: metadata.data,
            page: page.data,
          } satisfies AgentNavigationSnapshot;
        },
      });
    } catch {
      /* An unavailable agent must not block the other recent agents. */
    }
  }
}
