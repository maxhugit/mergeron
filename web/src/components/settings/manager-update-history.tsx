import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { translationKey } from '@/locales/translation-key';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import {
  managerHistoryKey,
  requestManagerHistory,
  type ManagerStatus,
  type ManagerUpdateOperation,
} from './manager-status-api';

function OperationChanges({ id }: { id: string }) {
  const { t } = useTranslation('manager');
  const query = useQuery({
    queryKey: [...managerHistoryKey, id, 'changes'],
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const authorization = getAuthorizationHeader();
      const response = await fetch(
        withBasePath(
          `/api/settings/manager/update/history/${encodeURIComponent(id)}/changes`,
        ),
        { headers: authorization ? { Authorization: authorization } : {} },
      );
      if (!response.ok) throw Error('historyUnavailable');
      return (await response.json()) as {
        items: string[];
        unavailable: boolean;
      };
    },
  });
  return (
    <div className="mt-3 text-sm">
      {query.data?.items.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {query.data.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            query.isPending
              ? 'managerBackupsLoading'
              : 'historyNotesUnavailable',
          )}
        </p>
      )}
    </div>
  );
}

export function ManagerUpdateHistory({ status }: { status: ManagerStatus }) {
  const { t, i18n } = useTranslation('manager');
  const [log, setLog] = useState<ManagerUpdateOperation | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const query = useQuery({
    queryKey: managerHistoryKey,
    queryFn: requestManagerHistory,
    enabled: status.available && status.capabilities?.updateHistory === true,
    refetchInterval: status.update?.busy ? 2000 : 30000,
    retry: false,
  });
  const date = (value?: string | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : '—';
  const build = (value?: {
    version: string | null;
    revision: string | null;
  }) =>
    value
      ? [value.version, value.revision?.slice(0, 7)]
          .filter(Boolean)
          .join(' · ') || t('versionUnknown')
      : t('versionUnknown');
  return (
    <section className="space-y-3">
      <h2 className="font-medium">{t('serverUpdateTab')}</h2>
      <p className="text-xs text-muted-foreground">{t('historyDescription')}</p>
      {!status.capabilities?.updateHistory && (
        <p role="status">{t('consoleManagerUpgrade')}</p>
      )}
      {query.isError && <p role="alert">{t('historyUnavailable')}</p>}
      {query.isPending && status.capabilities?.updateHistory && (
        <p role="status">{t('managerBackupsLoading')}</p>
      )}
      {query.data?.operations.length === 0 && <p>{t('historyEmpty')}</p>}
      {query.data?.operations.map((op) => (
        <article className="rounded-lg border border-border p-4" key={op.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">
                {t(
                  op.hostObservation
                    ? 'historyManagerObserved'
                    : op.checkpoint
                      ? 'createBackupTitle'
                      : op.restoreSource
                        ? 'historyRestoration'
                        : 'historyUpdate',
                )}
              </h3>
              <p className="text-xs text-muted-foreground">
                {date(op.startedAt)} ·{' '}
                {op.actor?.name ?? t('historyUnknownActor')}
              </p>
              <p className="text-xs">
                {op.hostObservation
                  ? t('historyObservedOnly')
                  : op.checkpoint && op.status === 'succeeded'
                    ? t('managerCheckpointSucceeded')
                    : t(
                        translationKey(
                          {
                            succeeded: 'managerUpdateSucceeded',
                            rolledBack: 'managerUpdateRolledBack',
                            recoveryRequired: 'managerUpdateRecoveryRequired',
                            running: 'managerUpdateRunning',
                            cancelled: 'historyCancelled',
                          }[op.status] ?? 'versionUnknown',
                        ),
                      )}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setLog(op)}>
              {t('historyViewLog')}
            </Button>
          </div>
          <details
            className="mt-3 text-sm"
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setExpanded((previous) => {
                const next = new Set(previous);
                if (open) next.add(op.id);
                else next.delete(op.id);
                return next;
              });
            }}
          >
            <summary className="cursor-pointer">
              {t('historyVersionsAndChanges')}
            </summary>
            {expanded.has(op.id) &&
              op.status === 'succeeded' &&
              !op.checkpoint &&
              !op.hostObservation && <OperationChanges id={op.id} />}
            {Object.entries(op.builds ?? {}).map(([id, pair]) => (
              <section key={id} className="mt-3 border-t pt-3">
                <h4 className="font-medium">
                  {id === 'browser'
                    ? 'Mergeron Browser'
                    : id === 'manager'
                      ? 'Manager'
                      : id === 'application'
                        ? 'Mergeron'
                        : id === 'ingress'
                          ? 'Ingress · Nginx'
                          : 'Squid'}
                </h4>
                <p>
                  {build(pair.from)} → {build(pair.to)}
                </p>
                {op.status === 'succeeded' &&
                pair.from.revision &&
                pair.to.revision &&
                /^[a-f0-9]{40}$/.test(pair.from.revision) &&
                /^[a-f0-9]{40}$/.test(pair.to.revision) ? (
                  <a
                    className="text-xs text-primary underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://github.com/maxhugit/mergeron/compare/${pair.from.revision}...${pair.to.revision}`}
                  >
                    {t('historyViewChanges')}
                  </a>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      op.status === 'succeeded'
                        ? 'historyNotesUnavailable'
                        : 'historyNoChangesApplied',
                    )}
                  </p>
                )}
              </section>
            ))}
            {Object.keys(op.builds ?? {}).length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('historyOldMetadata')}
              </p>
            )}
          </details>
        </article>
      ))}
      <Button
        variant="outline"
        disabled={query.isFetching || !status.capabilities?.updateHistory}
        onClick={() => void query.refetch()}
      >
        {t('managerRefreshDetection')}
      </Button>
      <Dialog
        open={!!log}
        onOpenChange={(open) => {
          if (!open) setLog(null);
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('historyViewLog')}</DialogTitle>
            <DialogDescription>
              {date(log?.startedAt)} ·{' '}
              {log?.actor?.name ?? t('historyUnknownActor')}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-3 overflow-auto">
            <p className="text-sm">
              {log?.hostObservation
                ? t('historyObservedOnly')
                : log?.error
                  ? t('historyErrorsRecorded')
                  : t('historyNoRecordedError')}
            </p>
            {log?.error && (
              <p className="text-sm text-destructive">
                {t(translationKey(log.error))}
              </p>
            )}
            <ol className="space-y-2 font-mono text-xs">
              {log?.events.map((event, index) => (
                <li className="rounded border p-2" key={index}>
                  <time>{date(event.at)}</time>
                  <br />
                  {t(
                    translationKey(
                      'managerUpdate' +
                        event.phase.charAt(0).toUpperCase() +
                        event.phase.slice(1),
                    ),
                  )}{' '}
                  · {event.status}
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              {t('historyStructuredLog')}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
