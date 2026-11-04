import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readAuthResource, updateAuthResource } from '@/lib/platform-session';
/** Server persistence is isolated by the authenticated person and exact agent. */
export function useAgentDocumentView(
  personId?: string | null,
  threadId?: string,
) {
  const client = useQueryClient(),
    key = ['agent-document-view', personId, threadId];
  const query = useQuery({
    queryKey: key,
    enabled: !!personId && !!threadId,
    queryFn: async () => {
      const value = await readAuthResource<{
        mode: 'plain' | 'labels';
        personId: string;
      }>(`me/document-explorer/${encodeURIComponent(threadId!)}`);
      if (value.personId !== personId) throw new Error('Identity changed');
      return value;
    },
    staleTime: 60000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (mode: 'plain' | 'labels') =>
      updateAuthResource<{ mode: 'plain' | 'labels' }>(
        `me/document-explorer/${encodeURIComponent(threadId!)}`,
        { mode, personId },
      ),
    onSuccess: (value) => client.setQueryData(key, value),
  });
  return {
    mode: query.data?.mode ?? 'plain',
    setMode: mutation.mutate,
    loading: query.isFetching || mutation.isPending,
    error: query.isError || mutation.isError,
    available: !!personId && !!threadId,
  };
}
