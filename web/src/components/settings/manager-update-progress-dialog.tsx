import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { retainManagerUpdateSnapshot } from './manager-update-recovery';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { translationKey } from '@/locales/translation-key';
import {
  requestManagerStatus,
  managerStatusQueryKey,
  type ManagerUpdateOperation,
} from './manager-status-api';

const stages = [
  'preparing',
  'stopping',
  'backingUp',
  'replacing',
  'checkingHealth',
  'committing',
];
const updatePhaseLabels: Record<string, string> = {
  preparing: 'managerUpdatePreparing',
  stopping: 'managerUpdateStopping',
  backingUp: 'managerUpdateBackingUp',
  replacing: 'managerUpdateReplacing',
  checkingHealth: 'managerUpdateCheckingHealth',
  committing: 'managerUpdateCommitting',
  rollingBack: 'managerUpdateRollingBack',
  recoveryRequired: 'managerUpdateRecoveryRequired',
  complete: 'managerUpdateComplete',
};

export function ManagerUpdateProgressDialog({
  open,
  onOpenChange,
  operation: initialOperation,
  pending,
  requestError,
  session,
  excludedOperationId,
  expectedOperationId,
  monitoringPaused = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  operation: ManagerUpdateOperation | null;
  pending: boolean;
  requestError: string | null;
  session: number;
  excludedOperationId: string | null;
  expectedOperationId?: string | null;
  /** No protected requests while session verification is temporarily unavailable. */
  monitoringPaused?: boolean;
}) {
  const { t, i18n } = useTranslation('manager');
  const { t: common } = useTranslation();
  const client = useQueryClient();
  const expectedId = initialOperation?.id ?? expectedOperationId;
  const query = useQuery({
    queryKey: ['administration', 'manager-update-progress', session],
    queryFn: async () => {
      const result = await requestManagerStatus();
      // Preserve the last received journal while the application restarts.
      if (!result.available || !result.update)
        throw new Error('mergeronManagerUnavailable');
      client.setQueryData(managerStatusQueryKey, result);
      return result;
    },
    enabled: open && !pending && !monitoringPaused,
    refetchInterval: (current) => {
      const operation = current.state.data?.update?.operation;
      return open &&
        !monitoringPaused &&
        (!operation ||
          operation.id === excludedOperationId ||
          (expectedId && operation.id !== expectedId) ||
          operation.status === 'running')
        ? 2_000
        : false;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const latest = monitoringPaused ? undefined : query.data?.update?.operation;
  const operation = pending
    ? null
    : latest &&
        latest.id !== excludedOperationId &&
        (!expectedId || latest.id === expectedId)
      ? latest
      : initialOperation;
  const phase = operation?.phase ?? 'preparing';
  const running =
    pending || (!operation && !requestError) || operation?.status === 'running';
  const locked = monitoringPaused || running;
  useEffect(() => {
    if (operation && !monitoringPaused)
      retainManagerUpdateSnapshot(session, operation);
  }, [operation, session, monitoringPaused]);
  const stage = stages.indexOf(phase);
  const completed = operation?.status === 'succeeded';
  const interrupted = operation?.status === 'recoveryRequired';
  const restored = operation?.status === 'rolledBack';
  const title =
    !operation && requestError
      ? 'managerUpdateStartUnconfirmed'
      : completed
        ? 'managerUpdateSucceeded'
        : restored
          ? 'managerUpdateRolledBack'
          : interrupted
            ? 'managerUpdateRecoveryRequired'
            : 'managerUpdateRunning';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !locked) onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col sm:max-w-2xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('managerUpdateProgressTitle')}</DialogTitle>
          <DialogDescription>
            {t('managerUpdateProgressDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3" role="status" aria-live="polite">
          <p className="flex items-center gap-2 font-medium">
            {running && (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            )}
            {t(translationKey(title))}
          </p>
          <p>
            {t(
              translationKey(
                updatePhaseLabels[phase] ?? 'managerUpdatePreparing',
              ),
            )}
          </p>
          <div
            role="progressbar"
            aria-label={t('managerUpdateProgressTitle')}
            aria-valuetext={t(
              translationKey(
                updatePhaseLabels[phase] ?? 'managerUpdatePreparing',
              ),
            )}
            aria-valuemin={0}
            aria-valuemax={stages.length}
            aria-valuenow={
              completed ? stages.length : stage >= 0 ? stage : undefined
            }
            className="flex gap-1"
          >
            {stages.map((item, index) => (
              <span
                key={item}
                className={`h-2 flex-1 rounded-full ${completed || index < stage ? 'bg-primary' : index === stage && running ? 'animate-pulse bg-primary/60' : 'bg-muted'}`}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {stage >= 0 && running && (
              <span className="mr-2 font-medium">
                {t('managerUpdateStageCount', {
                  current: stage + 1,
                  total: stages.length,
                })}
              </span>
            )}
            {t('managerUpdateStageProgress')}
          </p>
          {(monitoringPaused || query.isError) && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('managerUpdateReconnecting')}
            </p>
          )}
          {requestError && !operation && (
            <p role="alert" className="text-destructive">
              {t(translationKey(requestError), {
                defaultValue: t('managerUpdateRequestFailed'),
              })}{' '}
              {t('managerUpdateRequestUncertain')}
            </p>
          )}
          {operation?.error && (
            <p role="alert" className="text-destructive">
              {t(translationKey(operation.error))}
            </p>
          )}
        </div>
        <section
          className="min-h-0 space-y-2 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3"
          aria-label={t('managerUpdateJournal')}
        >
          <h3 className="text-sm font-medium">{t('managerUpdateJournal')}</h3>
          <ol
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="space-y-2 font-mono text-xs"
          >
            {!operation?.events.length && (
              <li>{t('managerUpdateAwaitingJournal')}</li>
            )}
            {operation?.events.map((event, index) => (
              <li key={`${operation.id}-${index}`}>
                <time dateTime={event.at}>
                  {new Date(event.at).toLocaleTimeString(i18n.language)}
                </time>
                {' · '}
                {t(
                  translationKey(
                    updatePhaseLabels[event.phase] ?? 'managerUpdatePreparing',
                  ),
                )}
              </li>
            ))}
          </ol>
        </section>
        {operation?.backupRetained && (
          <p className="text-xs text-muted-foreground">
            {t('managerUpdateBackupRetained')}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={locked}
            onClick={() => onOpenChange(false)}
          >
            {common('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
