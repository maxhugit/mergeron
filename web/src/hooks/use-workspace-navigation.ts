/** Cold opens hydrate; continuously subscribed retained views only select. */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  applyReadOnlySnapshot,
  HISTORY_PAGE_SIZE,
  useOpenThread,
} from './use-thread-open';
import { threadsListTurns, threadsReadThread } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { useAgentViewCacheStore } from '@/stores/agent-view-cache-store';
import { getSocket } from '@/socket';
import { currentThreadEpoch } from '@/lib/thread-recovery-epoch';
import { checkNavigationWorkspaces } from '@/lib/navigation-workspace-check';
import { getApiErrorMessage } from '@/lib/api-error';

export function useWorkspaceNavigation(threadId: string) {
  const queryClient = useQueryClient();
  const { mutate: openThread } = useOpenThread();
  const openingAttempt = useRef(0);
  const cancelOpening = useCallback(() => {
    openingAttempt.current++;
  }, []);
  const open = useCallback(
    (force = false) => {
      const attempt = ++openingAttempt.current;
      const store = useTimelineStore.getState();
      const held = store.getThreadRuntime(threadId);
      if (
        !force &&
        useAgentViewCacheStore.getState().threadIds.includes(threadId) &&
        held?.hydrated &&
        held.openState === 'ready' &&
        !held.deletedRemotely &&
        held.threadMode === 'live' &&
        held.readOnlyReason === null &&
        held.threadStatus?.type !== 'systemError' &&
        store.confirmedThreadIds.has(threadId) &&
        getSocket().connected
      ) {
        store.selectThread(threadId);
        return;
      }
      const resume = () => {
        // Navigation (including Activity hide) invalidates a delayed disk check.
        if (attempt !== openingAttempt.current) return;
        openThread(
          { path: { threadId } },
          {
            onError: () => {
              if (
                useTimelineStore.getState().getThreadRuntime(threadId)?.hydrated
              )
                return;
              const epoch = currentThreadEpoch(threadId);
              void Promise.all([
                threadsReadThread({ path: { threadId }, throwOnError: true }),
                threadsListTurns({
                  path: { threadId },
                  query: {
                    limit: HISTORY_PAGE_SIZE,
                    sortDirection: 'desc',
                    itemsView: 'full',
                  },
                  throwOnError: true,
                }),
              ])
                .then(([metadata, page]) => {
                  if (
                    epoch === currentThreadEpoch(threadId) &&
                    useTimelineStore.getState().threadId === threadId
                  )
                    return applyReadOnlySnapshot(metadata.data, page.data);
                })
                .catch((error: unknown) => {
                  if (epoch !== currentThreadEpoch(threadId)) return;
                  useTimelineStore.getState().setOpenStateForThread(threadId, {
                    openState: 'error',
                    historyRequest: 'error',
                    historyError: getApiErrorMessage(error),
                  });
                });
            },
          },
        );
      };
      void checkNavigationWorkspaces(queryClient, force).finally(resume);
    },
    [openThread, queryClient, threadId],
  );
  useEffect(() => {
    open();
    return () => {
      cancelOpening();
      if (!useTimelineStore.getState().retainedThreadIds.has(threadId))
        useTimelineStore.getState().unsubscribeThread(threadId);
    };
  }, [threadId, open, cancelOpening]);
  return open;
}
