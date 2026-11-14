import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { usePlatformSession } from '@/lib/platform-session';
import {
  getAgentPreferences,
  setAgentPreferences,
  type AgentPreferences,
} from '@/lib/agent-context-api';

export function ProfileAgentInstructions() {
  const { t } = useTranslation('workspaces');
  const session = usePlatformSession();
  const personId = session.data?.personId;
  const client = useQueryClient();
  const key = ['agent-preferences', personId];
  const [draft, setDraft] = useState<AgentPreferences | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getAgentPreferences(signal),
    enabled: session.data?.kind === 'person',
    retry: false,
  });
  const save = useMutation({
    mutationFn: setAgentPreferences,
    onSuccess: (data) => {
      client.setQueryData(['agent-preferences', data.personId], data);
      setDraft(null);
    },
  });
  const value =
    draft?.personId === personId
      ? draft
      : query.data?.personId === personId
        ? query.data
        : undefined;
  const bytes = new TextEncoder().encode(value?.instructions ?? '').length;
  if (session.data?.kind !== 'person') return null;
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">{t('contextProfileTitle')}</h3>
      <p className="text-xs text-muted-foreground">
        {t('contextProfileScope')}
      </p>
      {value && (
        <>
          <label className="grid gap-1 text-sm">
            {t('contextLanguage')}
            <select
              className="rounded-md border bg-background p-2"
              value={value.language}
              disabled={save.isPending}
              onChange={(e) =>
                setDraft({
                  ...value,
                  language: e.target.value as AgentPreferences['language'],
                })
              }
            >
              <option value="message">{t('contextMessageLanguage')}</option>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t('contextPersonalInstructions')}
            <Textarea
              rows={5}
              disabled={save.isPending}
              maxLength={8000}
              value={value.instructions}
              onChange={(e) =>
                setDraft({ ...value, instructions: e.target.value })
              }
            />
          </label>
          <p
            className={
              bytes > 8000
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {t('contextProfileBytes', { count: bytes })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                !draft ||
                draft.personId !== personId ||
                save.isPending ||
                bytes > 8000
              }
              onClick={() => save.mutate(value)}
            >
              {t('contextSave')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!draft || save.isPending}
              onClick={() => setDraft(null)}
            >
              {t('contextCancel')}
            </Button>
          </div>
        </>
      )}
      {query.isPending && <p role="status">{t('contextLoading')}</p>}
      {(query.isError || save.isError) && (
        <div role="alert" className="text-sm text-destructive">
          {t('contextError')}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void query.refetch()}
          >
            {t('contextRetry')}
          </Button>
        </div>
      )}
      {save.isSuccess && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('contextSaved')}
        </p>
      )}
    </section>
  );
}
