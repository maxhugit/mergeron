import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTimelineStore } from '@/stores/timeline-store';
import {
  useAgentDisplayStore,
  type AgentDisplayMode,
} from '@/stores/agent-display-store';
import {
  request,
  useAgentDisplayPreference,
} from '@/hooks/use-agent-display-preference';
type Detail = AgentDisplayMode;

export function ResponseDetailSelector({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const threadId = useTimelineStore((state) => state.threadId);
  const client = useQueryClient();
  const query = useAgentDisplayPreference(threadId);
  const mutation = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: Detail }) =>
      request(id, mode),
    onSuccess: async (data, variables) => {
      const key = ['agent-response-detail', variables.id];
      await client.cancelQueries({ queryKey: key });
      client.setQueryData(key, data);
      useAgentDisplayStore.getState().record(variables.id, data.mode);
    },
  });
  return (
    <div className="space-y-1 border-t px-2 pt-2">
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{t('technicalDetails')}</span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={query.data?.mode ?? 'collapsed'}
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
          <option value="hidden">{t('technicalDetailsHidden')}</option>
          <option value="collapsed">{t('technicalDetailsCollapsed')}</option>
          <option value="expanded">{t('technicalDetailsExpanded')}</option>
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
