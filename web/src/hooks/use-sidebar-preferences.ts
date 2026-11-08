import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readAuthResource, updateAuthResource } from '@/lib/platform-session';
export function useSidebarPreferences(
  personId: string | null | undefined,
  scope: string | undefined,
) {
  const client = useQueryClient();
  const key = ['sidebar-preferences', personId, scope];
  const query = useQuery({
    queryKey: key,
    enabled: !!personId && !!scope,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const value = await readAuthResource<{
        personId: string;
        values: Record<string, boolean | string>;
      }>(`me/sidebar/${encodeURIComponent(scope!)}`);
      if (value.personId !== personId) throw Error('Identity changed');
      return value;
    },
  });
  const mutation = useMutation({
    mutationFn: (change: {
      key: string;
      value: boolean | string;
      personId: string;
      scope: string;
    }) =>
      updateAuthResource<{
        personId: string;
        values: Record<string, boolean | string>;
      }>(`me/sidebar/${encodeURIComponent(change.scope)}`, {
        key: change.key,
        value: change.value,
        personId: change.personId,
      }),
    onSuccess: (value, change) => {
      if (value.personId === change.personId)
        client.setQueryData(
          ['sidebar-preferences', change.personId, change.scope],
          value,
        );
    },
  });
  return {
    values: query.data?.values ?? {},
    ready: !!query.data,
    pending: mutation.isPending,
    error: query.isError || mutation.isError,
    setMany: async (
      changes: Array<{ key: string; value: boolean | string }>,
    ) => {
      for (const change of changes) {
        try {
          if (!personId || !scope) return;
          await mutation.mutateAsync({ ...change, personId, scope });
        } catch {
          break;
        }
      }
    },
    set: (name: string, value: boolean | string) =>
      personId &&
      scope &&
      mutation.mutate({ key: name, value, personId, scope }),
  };
}
