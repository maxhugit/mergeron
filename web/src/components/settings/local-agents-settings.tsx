import { catalogRestartMutation } from '@/generated/api/@tanstack/react-query.gen';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  localAgentsApi,
  localAgentModelsKey,
  type LocalAgentConfiguration,
  type LocalAgentCatalog,
} from '@/lib/local-agents';

function ConfigurationForm({ initial }: { initial: LocalAgentConfiguration }) {
  const { t } = useTranslation(['common', 'localAgents'], {
    nsMode: 'fallback',
  });
  const client = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const save = useMutation({
    mutationFn: () =>
      localAgentsApi<LocalAgentConfiguration>('configuration', {
        enabled: draft.enabled,
        url: draft.url,
        models: draft.models,
        context: draft.context,
      }),
    onSuccess: async (value) => {
      client.setQueryData(['local-agent-configuration'], value);
      await client.invalidateQueries({ queryKey: localAgentModelsKey });
    },
  });
  const restart = useMutation({
    ...catalogRestartMutation(),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['local-agent-configuration'],
      });
      await client.invalidateQueries({ queryKey: localAgentModelsKey });
    },
  });
  const configured =
    client.getQueryData<LocalAgentConfiguration>([
      'local-agent-configuration',
    ]) ?? initial;
  const models = useQuery({
    queryKey: localAgentModelsKey,
    queryFn: ({ signal }) =>
      localAgentsApi<LocalAgentCatalog>('models', undefined, signal),
    retry: false,
    staleTime: 30000,
  });
  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending && !restart.isPending) save.mutate();
      }}
    >
      <h3 className="font-medium">{t('localAgentsTitle')}</h3>
      <p className="text-sm text-muted-foreground">{t('localAgentsScope')}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        {t('localAgentsEnable')}
      </label>
      <label className="grid gap-1 text-sm">
        {t('localAgentsUrl')}
        <Input
          value={draft.url}
          placeholder="http://192.168.1.10:11434"
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        />
      </label>
      <label className="grid gap-1 text-sm">
        {t('localAgentsModels')}
        <Input
          value={draft.models}
          placeholder="gpt-oss:local"
          onChange={(e) => setDraft({ ...draft, models: e.target.value })}
        />
      </label>
      <label className="grid gap-1 text-sm">
        {t('localAgentsContext')}
        <Input
          type="number"
          min={8192}
          max={131072}
          value={draft.context}
          onChange={(e) =>
            setDraft({ ...draft, context: Number(e.target.value) })
          }
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {t('localAgentsContextHelp')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending || restart.isPending}>
          {t('save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={models.isFetching || save.isPending || restart.isPending}
          onClick={() => void models.refetch()}
        >
          {t('localAgentsCheck')}
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('localAgentsSaveError')}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="text-sm">
          {t('localAgentsSaved')}
        </p>
      )}
      {configured.metadataRestartRequired && (
        <div role="status" className="space-y-2 rounded border p-3 text-sm">
          <p>{t('localAgentsMetadataRestart')}</p>
          <Button
            type="button"
            variant="outline"
            disabled={restart.isPending || save.isPending}
            onClick={() => restart.mutate({})}
          >
            {t('restartCodex')}
          </Button>
        </div>
      )}
      {restart.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('localAgentsRestartBlocked')}
        </p>
      )}
      {(models.isError || models.data?.error) && (
        <p role="alert" className="text-sm text-destructive">
          {t('localAgentsUnavailable')}
        </p>
      )}
      {models.data?.available && (
        <p role="status" className="text-sm">
          {t('localAgentsReady', { count: models.data.data.length })}
        </p>
      )}
    </form>
  );
}
export function LocalAgentsSettings() {
  const { t } = useTranslation(['common', 'localAgents'], {
    nsMode: 'fallback',
  });
  const query = useQuery({
    queryKey: ['local-agent-configuration'],
    queryFn: ({ signal }) =>
      localAgentsApi<LocalAgentConfiguration>(
        'configuration',
        undefined,
        signal,
      ),
    retry: false,
  });
  if (!query.data)
    return (
      <p role={query.isError ? 'alert' : 'status'}>
        {t(query.isError ? 'localAgentsLoadError' : 'loading')}
      </p>
    );
  return <ConfigurationForm initial={query.data} />;
}
