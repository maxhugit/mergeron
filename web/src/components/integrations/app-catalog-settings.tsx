import { translationKey } from '@/locales/translation-key';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { client } from '@/generated/api/client.gen';
import { appsListAppsQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { showSnackbar } from '@/stores/snackbar-store';

export interface CatalogStatus {
  source: 'native' | 'byparr';
  running: boolean;
  updatedAt: number | null;
  nextAttempt: number | null;
  count: number;
  stale: boolean;
  warning: boolean;
  worker?: {
    enabled: boolean;
    present: boolean;
    running: boolean;
    healthy: boolean;
    version: string | null;
    error: string | null;
  };
  history: Array<{
    at: number;
    status: 'running' | 'success' | 'failed';
    code: string;
    count?: number;
  }>;
}
const reasonKey = (code: string) =>
  'catalogReason.' +
  code
    .replace(/^CATALOG_/, '')
    .toLowerCase()
    .replace(/_([a-z])/g, (_match: string, value: string) =>
      value.toUpperCase(),
    );
const key = ['integrations', 'catalog-status'] as const;
export function AppCatalogSettings({
  onSourceChanged,
}: {
  onSourceChanged?: () => void;
}) {
  const { t, i18n } = useTranslation('integrations');
  const queryClient = useQueryClient();
  const [journal, setJournal] = useState(false);
  const status = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const { data } = await client.get<{ 200: CatalogStatus }, unknown, true>({
        url: '/api/apps/catalog/status',
        signal,
        throwOnError: true,
        ...{ meta: { silent: true } },
      });
      return data;
    },
    retry: false,
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
  });
  const change = useMutation({
    mutationFn: async (source: 'native' | 'byparr') => {
      const { data } = await client.post<{ 200: CatalogStatus }, unknown, true>(
        {
          url: '/api/apps/catalog/source',
          body: { source },
          throwOnError: true,
          ...{ meta: { silent: true } },
        },
      );
      return data;
    },
    onSuccess: async (data) => {
      onSourceChanged?.();
      queryClient.setQueryData(key, data);
      void queryClient.invalidateQueries({ queryKey: key });
      await queryClient.resetQueries({ queryKey: appsListAppsQueryKey() });
    },
    onError: () => {
      showSnackbar(t('catalogSetupFailed'), 'error');
      void status.refetch();
    },
  });
  const date = (value: number | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : t('catalogNever');
  const data = status.data;
  return (
    <section
      className="shrink-0 rounded-lg border p-3 text-sm"
      aria-label={t('catalogServer')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2">
          <Switch
            aria-label={t('catalogDaily')}
            checked={data?.source === 'byparr'}
            disabled={!data || change.isPending || data.running}
            onCheckedChange={(enabled) =>
              change.mutate(enabled ? 'byparr' : 'native')
            }
          />
          {t('catalogDaily')}
        </label>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={journal}
          onClick={() => setJournal(!journal)}
        >
          {t('catalogJournal')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('catalogSourceHelp')}
      </p>
      {data?.worker && (
        <p className="mt-2 text-xs" role="status">
          Byparr{data.worker.version ? ' ' + data.worker.version : ''}
          {' · '}
          {t(
            data.worker.error
              ? 'catalogWorkerUnavailable'
              : !data.worker.enabled
                ? 'catalogWorkerDisabled'
                : !data.worker.present
                  ? 'catalogWorkerMissing'
                  : !data.worker.running
                    ? 'catalogWorkerStopped'
                    : data.worker.healthy
                      ? 'catalogWorkerHealthy'
                      : 'catalogWorkerStarting',
          )}
        </p>
      )}
      {status.isError && (
        <p role="alert" className="mt-2 text-destructive">
          {t('catalogStatusFailed')}
        </p>
      )}
      {change.isPending && (
        <p role="status" className="mt-2">
          {t('catalogPreparing')}
        </p>
      )}
      {data?.source === 'byparr' && (
        <p className="mt-2 text-xs">
          {t('catalogDates', {
            count: data.count,
            last: date(data.updatedAt),
            next: date(data.nextAttempt),
          })}
        </p>
      )}
      {data &&
        (data.warning ||
          (data.source === 'byparr' && data.stale && !data.running)) && (
          <p role="alert" className="mt-2 text-destructive">
            {t('catalogWarning')}{' '}
            {t(
              translationKey(
                reasonKey(data.history[0]?.code ?? 'CATALOG_DOWNLOAD_FAILED'),
              ),
              { defaultValue: t('catalogReason.downloadFailed') },
            )}
          </p>
        )}
      {journal && (
        <div
          className="mt-3 max-h-56 overflow-auto rounded border"
          role="region"
          aria-label={t('catalogJournal')}
          tabIndex={0}
        >
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-popover">
              <tr>
                <th className="p-2">{t('catalogDate')}</th>
                <th className="p-2">{t('catalogResult')}</th>
              </tr>
            </thead>
            <tbody>
              {data?.history.map((entry, index) => (
                <tr key={entry.at + ':' + index} className="border-t">
                  <td className="whitespace-nowrap p-2 align-top">
                    {date(entry.at)}
                  </td>
                  <td className="p-2">
                    {t(translationKey('catalogAttempt.' + entry.status))}
                    {' · '}
                    {t(translationKey(reasonKey(entry.code)), {
                      defaultValue: t('catalogReason.downloadFailed'),
                    })}
                    {entry.count !== undefined ? ' · ' + entry.count : ''}
                  </td>
                </tr>
              ))}
              {!data?.history.length && (
                <tr>
                  <td colSpan={2} className="p-2">
                    {t('catalogNoHistory')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
