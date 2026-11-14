import { useQuery } from '@tanstack/react-query';
import { previewsDiagnostics } from '@/generated/api';

export function usePreviewRuntimeDiagnostics(
  projectId: string,
  threadId: string,
  runId: string,
) {
  return useQuery({
    queryKey: ['agent-preview', projectId, threadId, 'diagnostics', runId],
    queryFn: async ({ signal }) =>
      (
        await previewsDiagnostics({
          path: { projectId, threadId },
          signal,
          throwOnError: true,
          meta: { silent: true },
        })
      ).data,
    refetchInterval: (query) =>
      query.state.data?.state === 'running' ? 5000 : false,
    retry: false,
  });
}
