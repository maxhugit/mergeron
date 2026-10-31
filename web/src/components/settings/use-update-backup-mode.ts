/** Instance-wide preference, persisted by the existing administrator settings API. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  settingsGetSetting,
  settingsUpdateSetting,
} from '@/generated/api/sdk.gen';

export const updateBackupModeKey = 'general.updateBackupMode';
export const updateBackupModeQueryKey = ['administration', updateBackupModeKey];
type BackupMode = 'full' | 'minimal' | 'none';
function mode(value: unknown): BackupMode {
  if (value === 'full' || value === 'minimal' || value === 'none') return value;
  throw new Error('Invalid saved backup mode');
}

export function useUpdateBackupMode(enabled: boolean) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<BackupMode | null>(null);
  const query = useQuery({
    queryKey: updateBackupModeQueryKey,
    enabled,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data } = await settingsGetSetting({
        path: { key: updateBackupModeKey },
        signal,
        throwOnError: true,
      });
      return mode(data.value);
    },
  });
  const mutation = useMutation({
    mutationFn: async (value: BackupMode) => {
      const { data } = await settingsUpdateSetting({
        path: { key: updateBackupModeKey },
        body: { value },
        throwOnError: true,
      });
      const saved = mode(data.value);
      if (saved !== value) throw new Error('Backup preference was not saved');
      return saved;
    },
    onSuccess: (value) => {
      // Stop a stale pre-save read from replacing the confirmed saved value.
      void client.cancelQueries({ queryKey: updateBackupModeQueryKey });
      client.setQueryData(updateBackupModeQueryKey, value);
      setDraft(null);
    },
    retry: false,
  });
  const value = draft ?? query.data ?? 'full';
  return {
    value,
    setValue: (value: BackupMode) => {
      mutation.reset();
      setDraft(value);
    },
    dirty: draft !== null && draft !== query.data,
    ready: !enabled || (!query.isPending && !query.isError),
    loading: enabled && query.isPending,
    saving: mutation.isPending,
    readError: enabled && query.isError,
    saveError: mutation.isError,
    saved: mutation.isSuccess && draft === null,
    retry: () => void query.refetch(),
    save: () => mutation.mutate(value),
  };
}
