import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readAuthResource, updateAuthResource } from '@/lib/platform-session';

export type ExplorerTab = 'folders' | 'deliverables' | 'tasks' | 'sources';
type Preference = { personId: string; projectId: string; tab: ExplorerTab };
const key = (personId: string, projectId: string) =>
  ['project-explorer-tab', personId, projectId] as const;

function checked(value: Preference, personId: string, projectId: string) {
  if (
    value.personId !== personId ||
    value.projectId !== projectId ||
    !['folders', 'deliverables', 'tasks', 'sources'].includes(value.tab)
  )
    throw Error('Explorer preference identity changed');
  return value;
}

export function useProjectExplorerTab(
  personId: string | undefined | null,
  projectId: string | undefined,
) {
  const client = useQueryClient();
  const enabled = Boolean(personId && projectId);
  const query = useQuery({
    queryKey: key(personId ?? '', projectId ?? ''),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) =>
      checked(
        await readAuthResource<Preference>(
          `me/project-explorer/${encodeURIComponent(projectId!)}`,
          signal,
        ),
        personId!,
        projectId!,
      ),
  });
  const mutation = useMutation({
    // Retained agent panels share a QueryClient. Keep their explicit choices
    // ordered even when the first panel's save has not returned yet.
    scope: { id: 'project-explorer-tab' },
    onMutate: (change: Preference) =>
      client.cancelQueries({
        queryKey: key(change.personId, change.projectId),
        exact: true,
      }),
    mutationFn: async (change: Preference) =>
      checked(
        await updateAuthResource<Preference>(
          `me/project-explorer/${encodeURIComponent(change.projectId)}`,
          {
            personId: change.personId,
            tab: change.tab,
          },
        ),
        change.personId,
        change.projectId,
      ),
    onSuccess: (value, change) =>
      client.setQueryData(key(change.personId, change.projectId), value),
  });
  const ownMutation = Boolean(
    mutation.variables &&
    mutation.variables.personId === personId &&
    mutation.variables.projectId === projectId,
  );
  return {
    tab: query.data?.tab ?? 'folders',
    loading: enabled && query.isPending,
    saving: ownMutation && mutation.isPending,
    error: query.isError || (ownMutation && mutation.isError),
    select: async (tab: ExplorerTab) => {
      if (!personId || !projectId) return false;
      try {
        await mutation.mutateAsync({ personId, projectId, tab });
        return true;
      } catch {
        return false;
      }
    },
  };
}
