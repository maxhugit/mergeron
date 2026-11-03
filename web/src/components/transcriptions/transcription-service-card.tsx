import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { transcriptionRequest } from './api';
export function TranscriptionServiceCard() {
  const { t } = useTranslation('transcription');
  const query = useQuery({
    queryKey: ['transcription-status'],
    queryFn: ({ signal }) =>
      transcriptionRequest<{
        enabled: boolean;
        state: string;
        containerId: string | null;
        image: string;
        build?: { version?: string; revision?: string } | null;
        updateAvailable: boolean;
        updateCheckError: string | null;
      }>('status', { signal }),
    refetchInterval: 30_000,
  });
  return (
    <section className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">{t('title')}</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('refresh')}
        </Button>
      </div>
      {query.isError ? (
        <p role="alert">{t('serviceError')}</p>
      ) : query.data ? (
        <>
          <p className="text-sm">
            {t('serviceState', { state: query.data.state })}
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {query.data.image} · {query.data.build?.version ?? '—'} ·{' '}
            {query.data.build?.revision?.slice(0, 7) ?? '—'}
          </p>
          <p className="text-xs">
            {query.data.updateCheckError
              ? t('updateCheckFailed')
              : query.data.updateAvailable
                ? t('imageAvailable')
                : t('servicePolicy')}
          </p>
          {!query.data.enabled && <p className="text-xs">{t('disabled')}</p>}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('entryPoint')}</p>
    </section>
  );
}
