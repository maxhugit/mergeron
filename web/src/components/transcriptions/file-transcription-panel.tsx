import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { translationKey } from '@/locales/translation-key';
import {
  buildPreviewHeaders,
  buildPreviewUrl,
  type PreviewSource,
} from '../files/viewers/preview-source';
import {
  mediaSourceKey,
  transcriptionRequest,
  downloadJobAudio,
  type MediaOperation,
  transcriptSrt,
  type TranscriptionJob,
} from './api';
const done = new Set([
  'ready',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);
const MAX_BYTES = 128 * 1024 ** 2;
export function FileTranscriptionPanel({ source }: { source: PreviewSource }) {
  const { t } = useTranslation('transcription');
  const client = useQueryClient();
  const sourceId =
    source.kind === 'file'
      ? source.filePath
      : JSON.stringify([source.archivePath, source.entryPath]);
  const filename =
    (source.kind === 'file' ? source.filePath : source.entryPath)
      .split('/')
      .pop() ?? 'audio.wav';
  const sourceKey = useQuery({
    queryKey: ['transcription-source-key', sourceId],
    queryFn: () => mediaSourceKey(sourceId),
    staleTime: Infinity,
  });
  const key = sourceKey.data ?? '';
  const [pages, setPages] = useState<Record<string, number>>({});
  const status = useQuery({
    queryKey: ['transcription-status'],
    queryFn: ({ signal }) =>
      transcriptionRequest<{ enabled: boolean; state: string }>('status', {
        signal,
      }),
    staleTime: 30_000,
  });
  const queryKey = ['transcription-jobs', key];
  const jobs = useQuery({
    queryKey,
    enabled: !!key,
    queryFn: ({ signal }) =>
      transcriptionRequest<TranscriptionJob[]>('jobs?sourceKey=' + key, {
        signal,
      }),
    refetchInterval: (query) =>
      query.state.data?.some((job) => !done.has(job.state)) ? 2000 : false,
  });
  const control = useRef<AbortController | null>(null);
  useEffect(() => () => control.current?.abort(), []);
  const create = useMutation({
    mutationFn: async (operation: MediaOperation) => {
      const abort = new AbortController();
      control.current = abort;
      try {
        const response = await fetch(buildPreviewUrl(source), {
          headers: buildPreviewHeaders(),
          signal: abort.signal,
        });
        if (!response.ok) throw Error('HTTP ' + response.status);
        if (Number(response.headers.get('Content-Length')) > MAX_BYTES)
          throw Error(t('tooLarge'));
        const reader = response.body?.getReader();
        if (!reader) throw Error(t('failed'));
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw Error(t('tooLarge'));
            chunks.push(new Uint8Array(value));
          }
        } finally {
          await reader.cancel();
        }
        const form = new FormData();
        form.append('file', new Blob(chunks), filename);
        return await transcriptionRequest<TranscriptionJob>(
          'jobs?sourceKey=' + key + '&operation=' + operation,
          { method: 'POST', body: form, signal: abort.signal },
        );
      } finally {
        control.current = null;
        void client.invalidateQueries({ queryKey });
      }
    },
    onSuccess: () => void client.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      transcriptionRequest('jobs/' + id, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey }),
  });
  const audioDownload = useMutation({ mutationFn: downloadJobAudio });
  const download = (job: TranscriptionJob, format: 'txt' | 'srt' | 'json') => {
    if (!job.result) return;
    const text =
      format === 'txt'
        ? job.result.text
        : format === 'srt'
          ? transcriptSrt(job.result)
          : JSON.stringify(job.result, null, 2);
    const url = URL.createObjectURL(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = job.filename + '.' + format;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      aria-label={t('title')}
      className="flex min-h-0 w-full flex-1 flex-col gap-2 rounded-lg border bg-background p-3 text-foreground"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <div className="flex flex-wrap items-center gap-1">
          {(['extract', 'transcribe', 'both'] as const).map((operation) => (
            <Button
              key={operation}
              size="sm"
              variant={operation === 'transcribe' ? 'default' : 'outline'}
              disabled={
                !key ||
                status.data?.enabled !== true ||
                create.isPending ||
                jobs.data?.some((job) => !done.has(job.state))
              }
              onClick={() => create.mutate(operation)}
            >
              {t(
                operation === 'extract'
                  ? 'extract'
                  : operation === 'both'
                    ? 'both'
                    : 'start',
              )}
            </Button>
          ))}
          {create.isPending && (
            <span className="text-xs" role="status">
              {t('uploading')}
            </span>
          )}
        </div>
        {create.isPending && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => control.current?.abort()}
          >
            {t('cancel')}
          </Button>
        )}
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">{t('privacy')}</p>
      {status.isError || jobs.isError || sourceKey.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('serviceError')}
        </p>
      ) : status.data?.enabled === false ? (
        <p className="text-sm text-muted-foreground">{t('disabled')}</p>
      ) : null}
      {(create.isError || remove.isError || audioDownload.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {create.error instanceof Error ? create.error.message : t('failed')}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
        {jobs.data?.map((job) => (
          <article key={job.id} className="space-y-2 rounded-md border p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span role="status" className="text-sm">
                {t(translationKey('states.' + job.state))} ·{' '}
                {new Date(job.createdAt).toLocaleString()}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(job.id)}
              >
                {done.has(job.state) ? t('delete') : t('cancel')}
              </Button>
            </div>
            {job.error && (
              <p role="alert" className="text-sm text-destructive">
                {t('failed')} ({job.error})
              </p>
            )}
            {job.audio && ['ready', 'partial'].includes(job.state) && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={audioDownload.isPending}
                  onClick={() => audioDownload.mutate(job)}
                >
                  {t('downloadAudio')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  MP3 ·{' '}
                  {t('audioSize', {
                    kilobytes: Math.ceil(job.audio.size / 1024),
                  })}
                </span>
              </div>
            )}
            {job.result && (
              <>
                <p className="text-xs">
                  {t('language', {
                    language: job.result.language,
                    confidence: Math.round(
                      job.result.languageProbability * 100,
                    ),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    job.result.diarization.state === 'ready'
                      ? 'anonymous'
                      : job.result.diarization.state === 'failed'
                        ? 'speakersFailed'
                        : 'speakersUnavailable',
                  )}
                </p>
                <div className="flex gap-2">
                  {(['txt', 'srt', 'json'] as const).map((format) => (
                    <Button
                      size="sm"
                      variant="outline"
                      key={format}
                      onClick={() => download(job, format)}
                    >
                      {format.toUpperCase()}
                    </Button>
                  ))}
                </div>
                {job.result.segments.length === 0 && (
                  <p className="text-sm">{t('emptySpeech')}</p>
                )}
                {job.result.segments.length > 200 && (
                  <div className="flex items-center gap-2 text-xs">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!pages[job.id]}
                      onClick={() =>
                        setPages((p) => ({
                          ...p,
                          [job.id]: Math.max(0, (p[job.id] ?? 0) - 1),
                        }))
                      }
                    >
                      {t('previous')}
                    </Button>
                    <span>
                      {(pages[job.id] ?? 0) + 1} /{' '}
                      {Math.ceil(job.result.segments.length / 200)}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        ((pages[job.id] ?? 0) + 1) * 200 >=
                        job.result.segments.length
                      }
                      onClick={() =>
                        setPages((p) => ({
                          ...p,
                          [job.id]: (p[job.id] ?? 0) + 1,
                        }))
                      }
                    >
                      {t('next')}
                    </Button>
                  </div>
                )}
                {job.result.segments
                  .slice(
                    (pages[job.id] ?? 0) * 200,
                    ((pages[job.id] ?? 0) + 1) * 200,
                  )
                  .map((s, i) => (
                    <p
                      key={i}
                      className="whitespace-pre-wrap break-words text-sm"
                    >
                      <span className="text-xs text-muted-foreground">
                        {Math.floor(s.start / 60)}:
                        {String(Math.floor(s.start % 60)).padStart(2, '0')}
                        {s.speaker
                          ? ' · ' + t('speaker', { number: s.speaker.slice(8) })
                          : ''}{' '}
                      </span>
                      {s.text}
                    </p>
                  ))}
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
