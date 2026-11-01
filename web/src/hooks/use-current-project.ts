import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import {
  projectForWorkspace,
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import { useTimelineStore } from '@/stores/timeline-store';

/** Returns the project owning the workspace of the visible Codex conversation. */
export function useCurrentProject(): ProjectSummary | undefined {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const threadId = pathname.startsWith('/t/')
    ? decodeURIComponent(pathname.split('/')[2] ?? '')
    : '';
  const cwd = useTimelineStore((state) =>
    state.threadId === threadId
      ? state.threadCwd
      : state.threadsById[threadId]?.threadCwd,
  );
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
    enabled: Boolean(threadId),
  });
  return threadId
    ? (projects.data?.projects.find((project) =>
        project.agentThreads?.some((agent) => agent.threadId === threadId),
      ) ?? projectForWorkspace(projects.data?.projects, cwd ?? null))
    : undefined;
}
