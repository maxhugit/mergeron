/** Bounded view retention, independent of route/selection and of socket ingestion. */
import { lazy, Suspense, useLayoutEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  MAX_CACHED_AGENT_VIEWS,
  useAgentViewCacheStore,
} from '@/stores/agent-view-cache-store';
import { useTimelineStore } from '@/stores/timeline-store';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import { RetainedSurface } from '@/components/retained-surface';
import { retainAgentFilesStores } from '@/stores/files-store';
import { useAgentNavigationPrefetch } from '@/hooks/use-agent-navigation-prefetch';

const Workspace = lazy(() =>
  import('@/routes/thread-view').then((m) => ({
    default: m.ConversationWorkspace,
  })),
);

export function AgentWorkspaceHost({
  activeThreadId,
}: {
  activeThreadId: string | null;
}) {
  const projectId = useAgentViewCacheStore((s) => s.projectId);
  const retained = useAgentViewCacheStore((s) => s.threadIds);
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
    enabled: Boolean(projectId || activeThreadId),
  });
  const project = projects.data?.projects.find((p) => p.id === projectId);
  const eligible = useMemo(
    () =>
      new Set(
        project?.agentThreads
          ?.filter((agent) => !agent.archived)
          .map((agent) => agent.threadId) ?? [],
      ),
    [project],
  );
  const activeEligible = Boolean(
    activeThreadId && eligible.has(activeThreadId),
  );
  useAgentNavigationPrefetch(projectId, activeThreadId, eligible);
  const cached = [
    ...retained.filter((id) => eligible.has(id) && id !== activeThreadId),
    ...(activeEligible ? [activeThreadId!] : []),
  ].slice(-MAX_CACHED_AGENT_VIEWS);
  // Include the selected agent synchronously: do not unmount/remount it while
  // the LRU bookkeeping effect catches up to navigation or a newly enabled mode.
  const ids = [
    ...new Set([...cached, ...(activeThreadId ? [activeThreadId] : [])]),
  ];
  const retainedKey = cached.join('\0');
  const idsKey = ids.join('\0');
  useLayoutEffect(() => {
    retainAgentFilesStores(idsKey ? idsKey.split('\0') : []);
    if (projectId && projects.isSuccess && project) {
      const state = useAgentViewCacheStore.getState();
      const valid = state.threadIds.filter((id) => eligible.has(id));
      state.forget(state.threadIds.filter((id) => !eligible.has(id)));
      // A first reload has no recent IDs yet. Seed a bounded selection, with
      // the selected conversation last in the LRU and first on the open path.
      if (state.owner && valid.length === 0) {
        for (const id of [...eligible]
          .filter((id) => id !== activeThreadId)
          .slice(0, MAX_CACHED_AGENT_VIEWS - 1)
          .reverse())
          state.visit(projectId, id);
      }
    }
    if (projectId && activeThreadId && activeEligible)
      useAgentViewCacheStore.getState().visit(projectId, activeThreadId);
    const state = useAgentViewCacheStore.getState();
    useTimelineStore
      .getState()
      .setRetainedThreads(state.threadIds.filter((id) => eligible.has(id)));
    if (
      activeThreadId &&
      useTimelineStore.getState().threadId !== activeThreadId &&
      useTimelineStore.getState().getThreadRuntime(activeThreadId)
    )
      useTimelineStore.getState().selectThread(activeThreadId);
    else if (!activeThreadId && useTimelineStore.getState().threadId)
      useTimelineStore.getState().selectThread(null);
    if (projectId && projects.isSuccess && !project)
      useAgentViewCacheStore.getState().clear();
  }, [
    activeThreadId,
    activeEligible,
    projectId,
    retainedKey,
    eligible,
    project,
    projects.isSuccess,
    idsKey,
  ]);
  return ids.map((threadId) => {
    const active = threadId === activeThreadId;
    return (
      <RetainedSurface key={threadId} active={active}>
        <Suspense fallback={null}>
          <Workspace threadId={threadId} />
        </Suspense>
      </RetainedSurface>
    );
  });
}
