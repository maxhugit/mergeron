import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePlatformSession } from '@/lib/platform-session';
import {
  isSessionPaused,
  sessionOwner,
  sessionVerificationGeneration,
} from '@/lib/session-recovery';
import { useAgentViewCacheStore } from '@/stores/agent-view-cache-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { prefetchAgentNavigation } from '@/lib/agent-navigation-prefetch';

function subscribeAvailability(notify: () => void) {
  document.addEventListener('visibilitychange', notify);
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    document.removeEventListener('visibilitychange', notify);
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}
const available = () =>
  document.visibilityState !== 'hidden' && navigator.onLine;

/** Start after the selected conversation has opened, one background read at a time. */
export function useAgentNavigationPrefetch(
  projectId: string | null,
  activeThreadId: string | null,
  eligible: ReadonlySet<string>,
) {
  const client = useQueryClient();
  const foreground = useSyncExternalStore(subscribeAvailability, available);
  const session = usePlatformSession();
  const owner = useAgentViewCacheStore((state) => state.owner);
  const ids = useAgentViewCacheStore((state) => state.threadIds);
  const activeReady = useTimelineStore((state) =>
    activeThreadId
      ? state.threadsById[activeThreadId]?.openState === 'ready'
      : true,
  );
  const verified =
    session.data?.active &&
    session.data.kind === 'person' &&
    !session.isPending &&
    !session.isError &&
    !session.paused &&
    sessionOwner(session.data) === owner;
  const candidates = [...ids]
    .reverse()
    .filter((id) => eligible.has(id) && id !== activeThreadId)
    .slice(0, 4);
  const key = candidates.join('\0');
  useEffect(() => {
    if (!projectId || !owner || !verified || !activeReady || !foreground)
      return;
    const keep = new Set([
      ...(key ? key.split('\0') : []),
      ...(activeThreadId ? [activeThreadId] : []),
    ]);
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === 'agent-navigation-snapshot' &&
        query.queryKey[1] === owner &&
        query.queryKey[2] === projectId &&
        !keep.has(String(query.queryKey[3])),
    });
    const controller = new AbortController();
    const generation = sessionVerificationGeneration();
    const current = () => {
      const state = useAgentViewCacheStore.getState();
      return (
        !isSessionPaused() &&
        generation === sessionVerificationGeneration() &&
        state.owner === owner &&
        state.projectId === projectId
      );
    };
    const warm = () => {
      if (
        document.visibilityState === 'hidden' ||
        !navigator.onLine ||
        !current()
      )
        return;
      void import('@/routes/project-resource-route').catch(() => undefined);
      void prefetchAgentNavigation(
        client,
        owner,
        projectId,
        key ? key.split('\0') : [],
        controller.signal,
        current,
      );
    };
    const timer = window.setTimeout(warm, 300);
    const pause = () => controller.abort();
    window.addEventListener('codex-webui:session-paused', pause);
    return () => {
      clearTimeout(timer);
      controller.abort();
      window.removeEventListener('codex-webui:session-paused', pause);
    };
  }, [
    client,
    owner,
    projectId,
    verified,
    activeReady,
    key,
    activeThreadId,
    foreground,
  ]);
  useEffect(
    () => () => {
      if (owner && projectId)
        client.removeQueries({
          queryKey: ['agent-navigation-snapshot', owner, projectId],
        });
    },
    [client, owner, projectId],
  );
}
