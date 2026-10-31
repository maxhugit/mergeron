import { useLayoutEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  executionPreferenceKey,
  requestExecutionPreferences,
  type AgentExecutionPreferences,
  type AgentModelChoices,
} from '@/lib/thread-execution-preferences';
import { useModelStore } from '@/stores/model-store';
import { useSnackbarStore } from '@/stores/snackbar-store';

/** Shared per-agent settings. Only an explicit selection writes; opening a view only reads. */
export function useThreadExecutionPreferences(threadId: string | null) {
  const client = useQueryClient();
  const { t } = useTranslation('workspaces');
  const query = useQuery({
    queryKey: executionPreferenceKey(threadId),
    queryFn: ({ signal }) =>
      requestExecutionPreferences(threadId!, undefined, signal),
    enabled: !!threadId,
    retry: false,
    staleTime: 1000,
    refetchOnWindowFocus: true,
    refetchInterval: (entry) =>
      entry.state.data?.securitySaveState === 'pending' ? 1000 : 30000,
  });
  const preferences = useModelStore((s) =>
    threadId ? s.preferencesByThread[threadId] : undefined,
  );
  const pending = useModelStore((s) =>
    threadId ? (s.pendingPreferencesByThread[threadId] ?? 0) : 0,
  );
  useLayoutEffect(() => {
    if (!threadId) return;
    if (query.data)
      useModelStore.getState().recordPreferences(threadId, query.data);
    useModelStore
      .getState()
      .setPreferencesLoading(
        threadId,
        !query.data && (query.isPending || query.isError),
      );
  }, [threadId, query.data, query.isPending, query.isError]);
  const save = useMutation({
    scope: { id: `agent-execution-preferences:${threadId}` },
    mutationFn: (input: { threadId: string; patch: AgentModelChoices }) =>
      requestExecutionPreferences(input.threadId, input.patch),
    onSuccess: (value, input) => {
      useModelStore.getState().recordPreferences(input.threadId, value);
      client.setQueryData<AgentExecutionPreferences>(
        executionPreferenceKey(input.threadId),
        (held) => (held && held.revision > value.revision ? held : value),
      );
    },
    onError: () =>
      useSnackbarStore.getState().show(t('agentSettingsSaveFailed'), 'error'),
    onSettled: (_data, _error, input) =>
      useModelStore.getState().changePendingPreferences(input.threadId, -1),
  });
  return {
    preferences,
    busy: pending > 0 || (!!threadId && !preferences),
    error: query.isError,
    retry: () => void query.refetch(),
    save: (patch: AgentModelChoices) => {
      if (
        !threadId ||
        !useModelStore.getState().preferencesByThread[threadId] ||
        (useModelStore.getState().pendingPreferencesByThread[threadId] ?? 0) > 0
      )
        return;
      useModelStore.getState().changePendingPreferences(threadId, 1);
      save.mutate({ threadId, patch });
    },
  };
}
