import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { ChevronDown, ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { OptionRow } from './option-row';
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
  const [open, setOpen] = useState(false);
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
  const mode = query.data?.mode ?? 'collapsed';
  const options = [
    ['hidden', t('technicalDetailsHidden')],
    ['collapsed', t('technicalDetailsCollapsed')],
    ['expanded', t('technicalDetailsExpanded')],
  ] as const;
  const locked =
    disabled ||
    !threadId ||
    query.isPending ||
    query.isError ||
    mutation.isPending;
  const selectedLabel = options.find(([value]) => value === mode)![1];
  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            title={t('technicalDetails')}
            className="h-7 w-full justify-start gap-1 rounded-lg px-2 text-xs"
          >
            <ListFilter className="h-3.5 w-3.5" />
            <span className="max-w-[220px] truncate">
              {t('technicalDetails')} · {selectedLabel}
            </span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          className="w-72 space-y-1 p-3 text-sm"
          aria-label={t('technicalDetails')}
        >
          <div className="text-xs font-medium text-muted-foreground">
            {t('technicalDetails')}
          </div>
          <fieldset disabled={locked} className="min-w-0 space-y-1">
            {options.map(([value, label]) => (
              <OptionRow
                key={value}
                active={mode === value}
                label={label}
                onSelect={() => {
                  if (locked || !threadId) return;
                  mutation.mutate({ id: threadId, mode: value });
                  setOpen(false);
                }}
              />
            ))}
          </fieldset>
        </PopoverContent>
      </Popover>
      {(query.isError ||
        (mutation.isError && mutation.variables?.id === threadId)) && (
        <p role="alert" className="text-xs text-destructive">
          {t('unableToSave')}
        </p>
      )}
    </div>
  );
}
