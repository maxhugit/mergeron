import { useQuery } from '@tanstack/react-query';
import { threadsListOverview } from '@/generated/api/sdk.gen';
import { threadsListOverviewQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import type { ThreadOverviewRowDto } from '@/generated/api';
import type { ProjectSummary } from '@/lib/projects-api';

/** Load metadata only, across every local folder and page, without the global
 * overview's 100-row ceiling. Keep the generated invalidation prefix. */
export function useFocusedProjectThreads(project: ProjectSummary | undefined) {
  const paths = [
    ...new Set(
      [
        project?.workspacePath,
        ...(project?.workspaces.map((workspace) => workspace.path) ?? []),
        ...(project?.agentThreads?.map((agent) => agent.workspacePath) ?? []),
      ].filter((path): path is string => Boolean(path)),
    ),
  ];
  return useQuery({
    queryKey: [
      ...threadsListOverviewQueryKey(),
      {
        focusedProject: project?.id,
        paths,
        members: project?.agentThreads?.map((agent) => agent.threadId).sort(),
      },
    ],
    enabled: Boolean(project),
    queryFn: async ({ signal }) => {
      const rows = new Map<string, ThreadOverviewRowDto>();
      const members = new Set(
        project?.agentThreads?.map((agent) => agent.threadId),
      );
      for (const cwd of paths) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const { data } = await threadsListOverview({
            query: {
              archived: false,
              cwd,
              cursor,
              limit: 100,
              sortKey: 'created_at',
            },
            signal,
            throwOnError: true,
          });
          for (const row of data.data) {
            if (row.memberThreadIds.some((id) => members.has(id)))
              rows.set(row.thread.id, row);
          }
          cursor = data.nextCursor ?? undefined;
          if (cursor && seen.has(cursor))
            throw new Error('Repeated thread cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      return {
        data: [...rows.values()].sort(
          (a, b) =>
            b.thread.createdAt - a.thread.createdAt ||
            b.thread.id.localeCompare(a.thread.id),
        ),
        nextCursor: null,
      };
    },
  });
}
