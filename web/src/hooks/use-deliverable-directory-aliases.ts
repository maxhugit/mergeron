import { useQueries } from '@tanstack/react-query';
import { projectsApi, type ProjectSummary } from '@/lib/projects-api';
import type { DeliverablesBoard } from '@/lib/deliverables-api';

/** Display metadata only: keys always remain the authoritative server paths. */
export function useDeliverableDirectoryAliases(project?: ProjectSummary) {
  const boards = useQueries({
    queries: (project?.resources ?? [])
      .filter((resource) => resource.type === 'deliverable_board')
      .map((resource) => ({
        queryKey: ['project-deliverables', project!.id, resource.id],
        queryFn: () =>
          projectsApi<DeliverablesBoard>(
            `/${project!.id}/resources/${resource.id}/deliverables`,
          ),
        staleTime: 30000,
        retry: false,
      })),
  });
  return Object.fromEntries(
    boards.flatMap((board) =>
      (board.data?.deliverables ?? [])
        .filter((item) => item.directory && item.title.trim())
        .map((item) => [item.directory.replace(/\/+$/, ''), item.title]),
    ),
  );
}
