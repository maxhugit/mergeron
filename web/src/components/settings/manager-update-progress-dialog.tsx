import { useIndependentUpdateMonitor } from './use-independent-update-monitor';
import { ensureUpdateMonitor } from './update-monitor-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { retainManagerUpdateSnapshot } from './manager-update-recovery';
import { backupDescription, withoutDataBackup } from './manager-backup-policy';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react';
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

const allStages = [
  'preparing',
  'stopping',
  'backingUp',
  'replacing',
  'checkingHealth',
  'committing',
];
const updatePhaseLabels: Record<string, string> = {
  preparing: 'managerUpdatePreparing',
  managerPending: 'globalManagerPending',
  managerReplacing: 'globalManagerReplacing',
  managerChecking: 'globalManagerChecking',
  managerRolledBack: 'globalManagerRolledBack',
  stopping: 'managerUpdateStopping',
  backingUp: 'managerUpdateBackingUp',
  restoring: 'managerUpdateRestoring',
  replacing: 'managerUpdateReplacing',
  checkingHealth: 'managerUpdateCheckingHealth',
  committing: 'managerUpdateCommitting',
  rollingBack: 'managerUpdateRollingBack',
  recoveryRequired: 'managerUpdateRecoveryRequired',
  complete: 'managerUpdateComplete',
};

const shortStageLabels: Record<string, string> = {
  preparing: 'monitorStepPrepare',
  stopping: 'monitorStepStop',
  backingUp: 'monitorStepBackup',
  restoring: 'monitorStepRestore',
  replacing: 'monitorStepInstall',
  checkingHealth: 'monitorStepVerify',
  committing: 'monitorStepFinalize',
  managerPending: 'monitorStepPrepareManager',
  managerReplacing: 'monitorStepInstallManager',
  managerChecking: 'monitorStepVerifyManager',
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
  independent = false,
  onMinimize,
  onRunningChange,
  monitorInBackground = false,
}: {
  independent?: boolean;
  /** Hide the window without clearing the recovery receipt or replaying the update. */
  onMinimize?: () => void;
  onRunningChange?: (running: boolean) => void;
  monitorInBackground?: boolean;
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
  useEffect(() => {
    if (!open || !independent || pending || monitoringPaused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const authorize = async () => {
      try {
        await ensureUpdateMonitor();
      } catch {
        if (!stopped) timer = setTimeout(() => void authorize(), 5000);
      }
    };
    void authorize();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, independent, pending, monitoringPaused, session]);

  const { t: common } = useTranslation();
  const client = useQueryClient();
  const expectedId = initialOperation?.id ?? expectedOperationId;
  const monitorUrlBase = expectedId
    ? `/_mergeron-update/?operation=${encodeURIComponent(expectedId)}`
    : excludedOperationId
      ? `/_mergeron-update/?exclude=${encodeURIComponent(excludedOperationId)}`
      : '/_mergeron-update/';
  const monitorUrl =
    monitorUrlBase +
    (monitorUrlBase.includes('?') ? '&' : '?') +
    'lang=' +
    encodeURIComponent(i18n.language);
  const monitor = useIndependentUpdateMonitor({
    enabled: independent && !pending && (open || monitorInBackground),
    session,
    expectedId,
    excludedId: excludedOperationId,
  });
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
        (!independent ||
          (!!monitor.data?.operation &&
            monitor.data.operation.status !== 'running' &&
            !current.state.data)) &&
        (!operation ||
          operation.id === excludedOperationId ||
          (expectedId &&
            operation.id !== expectedId &&
            current.state.data?.update?.busy !== false) ||
          operation.status === 'running')
        ? 2_000
        : false;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const latest = monitoringPaused ? undefined : query.data?.update?.operation;
  const superseded =
    !independent &&
    !pending &&
    !monitoringPaused &&
    !!expectedId &&
    (!initialOperation || initialOperation.status === 'running') &&
    !!latest &&
    latest.id !== expectedId &&
    latest.id !== excludedOperationId &&
    latest.status !== 'running' &&
    query.data?.update?.busy === false;
  const protectedOperation =
    latest?.id === expectedId || !expectedId ? latest : initialOperation;
  const publicOperation = monitor.data?.operation;
  const operation = useMemo<ManagerUpdateOperation | null>(
    () =>
      pending
        ? null
        : independent && publicOperation
          ? {
              ...(protectedOperation?.id === publicOperation.id
                ? protectedOperation
                : {}),
              id: publicOperation.id,
              phase: publicOperation.phase,
              status: publicOperation.status,
              checkpoint:
                publicOperation.checkpoint ??
                (protectedOperation?.id === publicOperation.id &&
                  protectedOperation?.checkpoint),
              monitorStages: publicOperation.stages,
              monitorObservedAt: monitor.data?.observedAt,
              events: publicOperation.events,
              backupRetained:
                protectedOperation?.id === publicOperation.id &&
                protectedOperation.backupRetained,
              images: {},
              previousImages: {},
            }
          : latest &&
              !independent &&
              latest.id !== excludedOperationId &&
              (!expectedId || latest.id === expectedId)
            ? latest
            : independent
              ? initialOperation?.monitorObservedAt
                ? initialOperation
                : null
              : initialOperation,
    [
      pending,
      independent,
      publicOperation,
      monitor.data?.observedAt,
      protectedOperation,
      latest,
      initialOperation,
      excludedOperationId,
      expectedId,
    ],
  );
  const phase = operation?.phase;
  const observedAt = monitor.data?.observedAt ?? operation?.monitorObservedAt;
  const running =
    !superseded &&
    (pending ||
      (!operation && !requestError) ||
      operation?.status === 'running');
  const locked = monitoringPaused || running;
  useEffect(() => {
    if (open || session > 0) onRunningChange?.(running);
  }, [open, session, running, onRunningChange]);
  useEffect(() => {
    if (operation && (!monitoringPaused || independent))
      retainManagerUpdateSnapshot(session, operation);
  }, [operation, session, monitoringPaused, independent]);
  const operationStages = operation?.checkpoint
    ? allStages.filter((item) => item !== 'replacing')
    : operation?.restoreSource
      ? [...allStages.slice(0, 3), 'restoring', ...allStages.slice(3)]
      : allStages;
  const hasManager =
    phase?.startsWith('manager') ||
    operation?.events.some((event) => event.phase.startsWith('manager'));
  const legacyStages = withoutDataBackup(operation?.backupPolicy)
    ? operationStages.filter((item) => item !== 'backingUp')
    : operationStages;
  const stages =
    operation?.monitorStages ??
    (hasManager
      ? [
          ...legacyStages,
          'managerPending',
          'managerReplacing',
          'managerChecking',
        ]
      : legacyStages);
  // Legacy public projections omit the plan: keep their journal, never invent completed backup steps.
  const planKnown =
    !independent ||
    Boolean(
      operation?.monitorStages?.length ||
      operation?.backupPolicy ||
      operation?.checkpoint ||
      operation?.restoreSource,
    );
  const stage = phase ? stages.indexOf(phase) : -1;
  const completed = operation?.status === 'succeeded';
  const interrupted = operation?.status === 'recoveryRequired';
  const cancelled = operation?.status === 'cancelled';
  const restored = operation?.status === 'rolledBack';
  const title = cancelled
    ? 'historyCancelled'
    : superseded
      ? 'managerUpdateSuperseded'
      : !operation
        ? requestError
          ? 'managerUpdateStartUnconfirmed'
          : 'managerUpdateAwaitingJournal'
        : completed && operation?.checkpoint
          ? 'managerCheckpointSucceeded'
          : completed
            ? 'managerUpdateSucceeded'
            : restored
              ? 'managerUpdateRolledBack'
              : interrupted
                ? 'managerUpdateRecoveryRequired'
                : operation?.checkpoint
                  ? 'managerCheckpointRunning'
                  : 'managerUpdateRunning';

  const phaseLabel = (value: string | undefined) =>
    t(translationKey(updatePhaseLabels[value ?? ''] ?? 'monitorUnknownPhase'));
  const connectionKey = !independent
    ? 'monitorApplicationSource'
    : monitor.error?.message === 'updateMonitorAuthenticationRequired'
      ? 'monitorAuthorizationRequired'
      : monitor.error?.message === 'updateMonitorOperationChanged'
        ? 'monitorOperationChanged'
        : monitor.isError
          ? 'monitorConnectionLost'
          : !monitor.data
            ? 'monitorConnecting'
            : 'monitorConnected';
  const connectionBadge =
    connectionKey === 'monitorConnectionLost'
      ? 'monitorInterruptedBadge'
      : connectionKey === 'monitorAuthorizationRequired'
        ? 'monitorAuthorizationBadge'
        : connectionKey === 'monitorOperationChanged'
          ? 'monitorDifferentOperationBadge'
          : connectionKey;
  const technicalOperation =
    !monitoringPaused &&
    !query.isError &&
    protectedOperation?.id === operation?.id
      ? protectedOperation
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !locked) onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <DialogTitle>{t('managerUpdateProgressTitle')}</DialogTitle>
          <DialogDescription>{t('monitorDescription')}</DialogDescription>
        </DialogHeader>
        <div
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5"
          data-update-monitor-body
        >
          <section
            role="status"
            aria-live="polite"
            className="shrink-0 space-y-2"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="rounded-lg bg-muted p-2" aria-hidden="true">
                  {completed ? (
                    <Check className="size-5 text-emerald-600" />
                  ) : restored || interrupted ? (
                    <CircleAlert className="size-5 text-amber-600" />
                  ) : (
                    <LoaderCircle
                      className={`size-5 ${running ? 'animate-spin motion-reduce:animate-none' : ''}`}
                    />
                  )}
                </span>
                <div className="min-w-0 space-y-1">
                  <h3 className="text-lg font-medium">
                    {running && phase
                      ? phaseLabel(phase)
                      : t(translationKey(title))}
                  </h3>
                  {operation && running && (
                    <p className="text-xs text-muted-foreground">
                      {t(translationKey(title))}
                    </p>
                  )}
                  {independent && observedAt && (
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {t('monitorObservedAt', {
                        time: new Date(observedAt).toLocaleTimeString(
                          i18n.language,
                        ),
                      })}
                    </p>
                  )}
                </div>
              </div>
              <span
                className={`text-xs ${monitor.isError ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}
              >
                {t(translationKey(connectionBadge))}
              </span>
            </div>
            {requestError && !operation && (
              <p role="alert" className="text-sm text-destructive">
                {t(translationKey(requestError), {
                  defaultValue: t('managerUpdateRequestFailed'),
                })}{' '}
                {t('managerUpdateRequestUncertain')}
              </p>
            )}
          </section>
          {operation && !superseded && planKnown && (
            <section
              className="shrink-0 space-y-2"
              aria-label={t('managerUpdateProgressTitle')}
            >
              <div
                role="progressbar"
                aria-label={t('managerUpdateProgressTitle')}
                aria-valuetext={phaseLabel(phase)}
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
                    className={`h-1.5 flex-1 rounded-full ${completed || index < stage ? 'bg-primary' : index === stage && running ? 'bg-primary/60' : 'bg-muted'}`}
                  />
                ))}
              </div>
              <ol className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
                {stages.map((item, index) => (
                  <li
                    key={item}
                    aria-current={
                      index === stage && running ? 'step' : undefined
                    }
                    className={`text-xs ${index === stage ? 'font-medium' : 'text-muted-foreground'}`}
                  >
                    <span className="mb-1 flex h-4 items-center tabular-nums">
                      {completed || index < stage ? (
                        <Check aria-hidden="true" className="size-3" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    {t(
                      translationKey(
                        shortStageLabels[item] ?? 'monitorUnknownPhase',
                      ),
                    )}
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted-foreground">
                {stage >= 0 &&
                  running &&
                  t('managerUpdateStageCount', {
                    current: stage + 1,
                    total: stages.length,
                  })}{' '}
                {t('monitorNoTimeEstimate')}
              </p>
            </section>
          )}
          {(monitor.isError ||
            superseded ||
            monitoringPaused ||
            (!independent && query.isError) ||
            (independent && operation?.status === 'running')) && (
            <p
              className="shrink-0 rounded-lg bg-muted/60 p-3 text-sm"
              role={monitor.isError ? 'alert' : undefined}
            >
              {t(
                translationKey(
                  superseded
                    ? 'managerUpdateSupersededHelp'
                    : independent
                      ? monitor.isError
                        ? connectionKey
                        : 'monitorRestartExpected'
                      : 'managerUpdateReconnecting',
                ),
              )}
            </p>
          )}
          <section
            className="flex min-h-32 flex-1 flex-col gap-2"
            aria-label={t('managerUpdateJournal')}
          >
            <h3 className="shrink-0 text-sm font-medium">
              {t('managerUpdateJournal')}
            </h3>
            <ol
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              className="max-h-56 min-h-0 flex-1 overflow-y-auto text-sm"
            >
              {!operation?.events.length && (
                <li className="py-2 text-muted-foreground">
                  {t('managerUpdateAwaitingJournal')}
                </li>
              )}
              {operation?.events.map((event, index) => (
                <li
                  key={`${operation.id}-${index}`}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-t py-2"
                >
                  <time
                    dateTime={event.at}
                    className="text-xs tabular-nums text-muted-foreground"
                  >
                    {new Date(event.at).toLocaleTimeString(i18n.language)}
                  </time>
                  <span className="break-words">
                    {event.phase === 'complete' &&
                    hasManager &&
                    (running || index < operation.events.length - 1)
                      ? t('monitorApplicationComplete')
                      : phaseLabel(event.phase)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <details className="shrink-0 border-t pt-3 text-xs">
            <summary className="cursor-pointer">
              {t('monitorTechnicalDetails')}
            </summary>
            <div className="mt-2 space-y-2 rounded-lg bg-muted/40 p-3">
              {technicalOperation ? (
                <>
                  {technicalOperation.error && (
                    <p role="alert" className="text-destructive">
                      {t(translationKey(technicalOperation.error))}
                    </p>
                  )}
                  {technicalOperation.backupPolicy && (
                    <p>
                      {t(
                        translationKey(
                          backupDescription(technicalOperation.backupPolicy),
                        ),
                      )}
                    </p>
                  )}
                  {technicalOperation.backupRetained && (
                    <p>{t('managerUpdateBackupRetained')}</p>
                  )}
                  <p>{t('monitorTechnicalAvailable')}</p>
                </>
              ) : (
                <p>{t('monitorTechnicalUnavailable')}</p>
              )}
            </div>
          </details>
        </div>
        <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-3 border-t px-5 py-3 sm:justify-between">
          {independent ? (
            <a
              className="inline-flex items-center gap-2 text-xs text-primary underline"
              href={monitorUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              {t('independentMonitorOpen')}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t('monitorApplicationSource')}
            </span>
          )}
          <Button
            variant="outline"
            disabled={locked && !onMinimize}
            onClick={() => (locked ? onMinimize?.() : onOpenChange(false))}
          >
            {locked ? t('monitorMinimize') : common('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
