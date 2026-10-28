/** Instance-wide instructions are independent of the connected Codex account. */
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  settingsGetSetting,
  settingsUpdateSetting,
} from '@/generated/api/sdk.gen';

const KEY = 'general.agentInstructions';
const agentInstructionsQueryKey = ['settings', KEY] as const;
const MAX_LENGTH = 12_000;

export function AgentInstructionsSettings({ active }: { active: boolean }) {
  const { t } = useTranslation('codexSettings');
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: agentInstructionsQueryKey,
    enabled: active,
    retry: false,
    queryFn: async () => {
      const { data } = await settingsGetSetting({
        path: { key: KEY },
        throwOnError: true,
      });
      return data;
    },
  });
  const baseline =
    typeof query.data?.value === 'string' ? query.data.value : '';
  const defaultText =
    typeof query.data?.defaultValue === 'string' ? query.data.defaultValue : '';
  const value = draft ?? baseline;
  const dirty = draft !== null && draft !== baseline;
  const mutation = useMutation({
    mutationFn: async (text: string) => {
      const { data } = await settingsUpdateSetting({
        path: { key: KEY },
        body: { value: text === defaultText ? null : text },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(agentInstructionsQueryKey, data);
      setDraft(null);
      setSaved(true);
    },
  });
  const edit = (text: string) => {
    setDraft(text);
    setSaved(false);
    mutation.reset();
  };

  return (
    <section
      hidden={!active}
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-3 rounded-lg border border-border bg-card/50 p-4"
    >
      <h3 id={`${id}-title`} className="font-medium">
        {t('commonInstructionsTitle')}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t('commonInstructionsScope')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('commonInstructionsSafety')}
      </p>
      {query.isPending && (
        <p role="status" className="text-sm">
          {t('commonInstructionsLoading')}
        </p>
      )}
      {query.isError && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {t('commonInstructionsLoadError')}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            {t('commonInstructionsRetry')}
          </Button>
        </div>
      )}
      {query.data && (
        <>
          <label htmlFor={`${id}-text`} className="block text-sm font-medium">
            {t('commonInstructionsLabel')}
          </label>
          <Textarea
            id={`${id}-text`}
            aria-describedby={`${id}-help`}
            rows={14}
            maxLength={MAX_LENGTH}
            value={value}
            disabled={mutation.isPending}
            onChange={(event) => edit(event.target.value)}
            className="field-sizing-fixed h-80 min-w-0 resize-y font-mono text-xs sm:text-sm"
          />
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {t('commonInstructionsHelp', {
              count: value.length,
              max: MAX_LENGTH,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                !dirty || mutation.isPending || value.length > MAX_LENGTH
              }
              onClick={() => mutation.mutate(value)}
            >
              {mutation.isPending
                ? t('commonInstructionsSaving')
                : t('commonInstructionsSave')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={mutation.isPending || value === defaultText}
              onClick={() => edit(defaultText)}
            >
              {t('commonInstructionsDefault')}
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => {
                  setDraft(null);
                  setSaved(false);
                  mutation.reset();
                }}
              >
                {t('commonInstructionsCancel')}
              </Button>
            )}
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('commonInstructionsSaveError')}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('commonInstructionsSaved')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
