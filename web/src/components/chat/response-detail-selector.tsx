import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { useTimelineStore } from '@/stores/timeline-store';

type Detail = 'concise' | 'normal' | 'detailed';

async function request(
  threadId: string,
  mode?: Detail,
): Promise<{ mode: Detail }> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(
      `/api/threads/${encodeURIComponent(threadId)}/response-detail`,
    ),
    {
      credentials: 'same-origin',
      redirect: 'error',
      method: mode ? 'PATCH' : 'GET',
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(mode ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(mode ? { body: JSON.stringify({ mode }) } : {}),
    },
  );
  if (!response.ok) throw new Error('Response detail unavailable');
  const result = (await response.json()) as { mode: Detail };
  if (!['concise', 'normal', 'detailed'].includes(result.mode))
    throw new Error('Invalid response detail');
  return result;
}

export function ResponseDetailSelector({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const threadId = useTimelineStore((state) => state.threadId);
  const client = useQueryClient();
  const key = ['agent-response-detail', threadId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => request(threadId!),
    enabled: !!threadId,
    retry: false,
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: Detail }) =>
      request(id, mode),
    onSuccess: async (data, variables) => {
      const key = ['agent-response-detail', variables.id];
      await client.cancelQueries({ queryKey: key });
      client.setQueryData(key, data);
    },
  });
  return (
    <div className="space-y-1 border-t px-2 pt-2">
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{t('verbosity')}</span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={query.data?.mode ?? 'normal'}
          disabled={
            disabled ||
            !threadId ||
            query.isPending ||
            query.isError ||
            mutation.isPending
          }
          onChange={(event) => {
            if (threadId)
              mutation.mutate({
                id: threadId,
                mode: event.target.value as Detail,
              });
          }}
        >
          <option value="concise">{t('concise')}</option>
          <option value="normal">{t('responseDetailNormal')}</option>
          <option value="detailed">{t('detailed')}</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">{t('responseDetailHint')}</p>
      {(query.isError ||
        (mutation.isError && mutation.variables?.id === threadId)) && (
        <p role="alert" className="text-xs text-destructive">
          {t('unableToSave')}
        </p>
      )}
    </div>
  );
}
