import { useQuery } from '@tanstack/react-query';
import { threadsListOverview } from '@/generated/api/sdk.gen';
import { threadsListOverviewQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import type { ThreadOverviewRowDto } from '@/generated/api';
import type { ProjectSummary } from '@/lib/projects-api';

/** Project membership, rather than the current working folder, defines focus.
 * The server filters before branch folding and pagination, including agents in
 * deliverables or other references without scanning unrelated projects. */
export function useFocusedProjectThreads(project: ProjectSummary | undefined) {
  return useQuery({
    queryKey: [
      ...threadsListOverviewQueryKey(),
      {
        focusedProject: project?.id,
        members: project?.agentThreads?.map((agent) => agent.threadId).sort(),
      },
    ],
    enabled: Boolean(project),
    queryFn: async ({ signal }) => {
      const rows = new Map<string, ThreadOverviewRowDto>();
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const { data } = await threadsListOverview({
          query: {
            projectId: project!.id,
            archived: false,
            cursor,
            limit: 100,
            sortKey: 'created_at',
          },
          signal,
          throwOnError: true,
        });
        for (const row of data.data) rows.set(row.thread.id, row);
        cursor = data.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          throw new Error('Repeated thread cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
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
