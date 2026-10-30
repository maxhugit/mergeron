import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { translationKey } from '@/locales/translation-key';
import {
  managerStatusQueryKey,
  requestManagerUpdate,
  type ManagerStatus,
  type ManagerUpdatePlan,
  type ManagerUpdateOperation,
} from './manager-status-api';
import { ManagerUpdateProgressDialog } from './manager-update-progress-dialog';
import { ManagerBackups } from './manager-backups';
import { ManagerImageUpdates } from './manager-image-updates';
import { componentUpdatesKey } from './manager-image-updates-api';
import { defaultManagerUpdateImage } from './manager-update-image';
import {
  readManagerUpdateReceipt,
  saveManagerUpdateReceipt,
} from './manager-update-recovery';
import {
  requestServerRelease,
  serverReleaseQueryKey,
} from './server-release-api';

const phases: Record<string, string> = {
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
const statuses: Record<string, string> = {
  running: 'managerUpdateRunning',
  succeeded: 'managerUpdateSucceeded',
  rolledBack: 'managerUpdateRolledBack',
  recoveryRequired: 'managerUpdateRecoveryRequired',
};

export function ManagerUpdateControls({
  status,
  trailingActions,
  showBackups = true,
  actionsContainer,
}: {
  status: ManagerStatus;
  trailingActions?: ReactNode;
  showBackups?: boolean;
  actionsContainer?: HTMLElement | null;
}) {
  const { t } = useTranslation('manager');
  const { t: common } = useTranslation();
  const client = useQueryClient();
  const release = useQuery({
    queryKey: serverReleaseQueryKey,
    queryFn: () => requestServerRelease(),
    enabled: true,
    staleTime: 15 * 60_000,
    retry: false,
  });
  const [imageOverride, setImage] = useState<string | null>(null);
  const [manualSelection, setManualSelection] = useState(false);
  const [fastEnabled, setFastEnabled] = useState(true);
  const fastAvailable =
    status.environment === 'development' &&
    status.capabilities?.devFastUpdate === true;
  const fastMode = fastAvailable && fastEnabled;
  const image =
    imageOverride ?? defaultManagerUpdateImage(status, release.data);
  const [plan, setPlan] = useState<ManagerUpdatePlan | null>(null);
  const [confirm, setConfirm] = useState<'apply' | 'rollback' | null>(null);
  const operation = status.update?.operation;
  const [receipt] = useState(readManagerUpdateReceipt);
  const [progressOpen, setProgressOpen] = useState(
    Boolean(status.update?.busy || receipt),
  );
  const [progressSession, setProgressSession] = useState(
    receipt?.startedAt ?? 0,
  );
  const [progressOperation, setProgressOperation] =
    useState<ManagerUpdateOperation | null>(
      operation?.id !== receipt?.excludedOperationId &&
        (!receipt?.operationId || operation?.id === receipt.operationId)
        ? (operation ?? receipt?.snapshot ?? null)
        : (receipt?.snapshot ?? null),
    );
  const [excludedOperationId, setExcludedOperationId] = useState<string | null>(
    receipt?.excludedOperationId ?? null,
  );
  const mutation = useMutation({
    mutationFn: ({
      action,
      input,
    }: {
      action: 'plan' | 'apply' | 'rollback' | 'recover';
      input: Record<string, unknown>;
    }) => requestManagerUpdate(action, input),
    onSuccess: (result, variables) => {
      const reviewed =
        variables.action === 'plan' && 'applicable' in result ? result : null;
      setPlan(reviewed);
      setConfirm(reviewed?.applicable ? 'apply' : null);
      if ('operation' in result) {
        setProgressOperation(result.operation);
        const saved = readManagerUpdateReceipt();
        if (saved && result.operation)
          saveManagerUpdateReceipt({
            ...saved,
            operationId: result.operation.id,
          });
      }
      void client.invalidateQueries({ queryKey: managerStatusQueryKey });
    },
  });
  const launch = (
    action: 'apply' | 'rollback' | 'recover',
    input: Record<string, unknown>,
  ) => {
    const startedAt = Date.now();
    saveManagerUpdateReceipt({
      startedAt,
      operationId: action === 'apply' ? null : (operation?.id ?? null),
      excludedOperationId: action === 'apply' ? (operation?.id ?? null) : null,
    });
    setProgressOperation(null);
    setExcludedOperationId(action === 'apply' ? (operation?.id ?? null) : null);
    setProgressSession(startedAt);
    setProgressOpen(true);
    mutation.mutate({ action, input });
  };
  const busy =
    status.update?.busy ||
    mutation.isPending ||
    (progressOperation?.status === 'running' &&
      operation?.id !== progressOperation.id);
  const blocked = operation?.status === 'recoveryRequired';
  const renderActions = (actions: ReactNode) =>
    actionsContainer ? (
      createPortal(actions, actionsContainer)
    ) : (
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    );
  if (!status.available && !progressOpen && !progressOperation)
    return <>{renderActions(trailingActions)}</>;
  return (
    <div className="order-first space-y-3">
      <div className="space-y-2">
        <label htmlFor="manager-update-image" className="text-sm">
          {t('managerTargetApplicationImage')}
        </label>
        <Input
          id="manager-update-image"
          value={image}
          disabled={busy || blocked}
          onChange={(event) => {
            setManualSelection(true);
            setImage(event.target.value);
            setPlan(null);
          }}
        />
      </div>
      {fastAvailable && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fastEnabled}
              disabled={busy || blocked}
              onChange={(event) => {
                setFastEnabled(event.target.checked);
                setPlan(null);
              }}
            />
            {t('managerFastDevUpdate')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              status.backupPolicy === 'development-none-v1'
                ? 'managerFastDevNoBackupHelp'
                : 'managerFastDevUpdateHelp',
            )}
          </p>
        </div>
      )}
      <h3 className="text-sm font-semibold">{t('managerUpdateAction')}</h3>
      <ManagerImageUpdates
        disabled={!!busy || !status.available || blocked}
        onUpdate={(images) => {
          mutation.mutate({
            action: 'plan',
            input: { images, ...(fastMode ? { mode: 'dev-fast' } : {}) },
          });
        }}
      />
      <p className="text-xs text-muted-foreground">
        {t(
          status.backupPolicy === 'development-none-v1'
            ? 'managerDevelopmentNoBackup'
            : status.backupPolicy === 'production-essential-v1'
              ? 'managerProductionEssentialBackup'
              : 'managerUpdateSafetyDescription',
        )}
      </p>
      {operation && operation.status !== 'succeeded' && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-border p-3 text-sm"
        >
          <p className="font-medium">
            {t(
              translationKey(
                statuses[operation.status] ?? 'managerUpdateRunning',
              ),
            )}
          </p>
          <p>
            {t(
              translationKey(
                phases[operation.phase] ?? 'managerUpdatePreparing',
              ),
            )}
          </p>
          {operation.backupRetained && (
            <p className="text-xs text-muted-foreground">
              {t('managerUpdateBackupRetained')}
            </p>
          )}
          {operation.error && (
            <p className="text-destructive">
              {t(translationKey(operation.error))}
            </p>
          )}
          {blocked && (
            <Button
              disabled={busy}
              onClick={() =>
                launch('recover', { confirmation: 'RETRY_RECOVERY' })
              }
            >
              {t('managerRetryRecovery')}
            </Button>
          )}
        </div>
      )}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t('managerUpdateSeparateFromSettings')}
        </p>
        {renderActions(
          <>
            <Button
              type="button"
              disabled={
                busy ||
                !status.available ||
                blocked ||
                !image.trim() ||
                (!manualSelection &&
                  (!release.data ||
                    release.isError ||
                    (!!release.data.targetImage &&
                      !release.data.updateAvailable)))
              }
              onClick={() => {
                // Keep the reviewed target fixed if release discovery finishes later.
                setImage(image.trim());
                const target =
                  !manualSelection &&
                  release.data?.targetDigest &&
                  release.data.targetImage === image
                    ? `ghcr.io/maxhugit/mergeron@${release.data.targetDigest}`
                    : image.trim();
                mutation.mutate({
                  action: 'plan',
                  input: {
                    images: { application: target },
                    ...(fastMode ? { mode: 'dev-fast' } : {}),
                  },
                });
              }}
            >
              {mutation.isPending
                ? t('managerCheckingPrerequisites')
                : t('managerPrepareUpdate')}
            </Button>
            {trailingActions}
            {(operation || progressOperation || progressSession > 0) && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setProgressOperation(operation ?? progressOperation);
                  setExcludedOperationId(null);
                  setProgressSession(Date.now());
                  setProgressOpen(true);
                }}
              >
                {t('managerViewUpdateProgress')}
              </Button>
            )}
            {operation?.status === 'succeeded' &&
              (operation.rollbackAvailable ?? operation.backupRetained) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirm('rollback')}
                >
                  {t('managerRestorePreviousVersion')}
                </Button>
              )}
          </>,
        )}
      </div>
      {plan && (
        <div className="space-y-2 text-sm">
          <p className="break-all font-mono text-xs">
            {Object.entries(plan.images)
              .map(([id, image]) => `${id}: ${image}`)
              .join('\n')}
          </p>
          {!plan.applicable && (
            <p role="alert">
              {t('managerUpdateBlocked')}{' '}
              <span className="text-xs">{plan.blockers.join(', ')}</span>
            </p>
          )}
        </div>
      )}
      {mutation.error && mutation.variables?.action === 'plan' && (
        <p role="alert" className="text-sm text-destructive">
          {t(translationKey(mutation.error.message))}
        </p>
      )}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                confirm === 'rollback'
                  ? 'managerRestorePreviousVersion'
                  : 'managerStartUpdate',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'apply' && plan && (
                <span className="mb-2 block break-all font-mono text-xs">
                  {Object.entries(plan.images)
                    .map(([id, image]) => `${id}: ${image}`)
                    .join('\n')}
                </span>
              )}
              {t(
                confirm === 'rollback'
                  ? operation?.backupPolicy === 'development-none-v1'
                    ? 'managerRollbackImagesOnlyWarning'
                    : 'managerRollbackDataWarning'
                  : plan?.backupPolicy === 'development-none-v1'
                    ? 'managerUpdateNoBackupWarning'
                    : plan?.backupPolicy === 'production-essential-v1'
                      ? 'managerUpdateEssentialWarning'
                      : 'managerUpdateDowntimeWarning',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{common('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (confirm === 'apply' && plan)
                  launch('apply', {
                    images: plan.images,
                    confirmation:
                      plan.backupPolicy === 'development-none-v1'
                        ? 'UPDATE_WITHOUT_DATA_BACKUP'
                        : 'UPDATE_WITH_ROLLBACK',
                    expectedFingerprint: plan.fingerprint,
                    ...(plan.mode ? { mode: plan.mode } : {}),
                  });
                if (confirm === 'rollback' && operation)
                  launch('rollback', {
                    operationId: operation.id,
                    confirmation:
                      operation.backupPolicy === 'development-none-v1'
                        ? 'ROLLBACK_IMAGES_ONLY'
                        : 'ROLLBACK_WITH_DATA_RESTORE',
                  });
              }}
            >
              {confirm === 'apply'
                ? t('managerConfirmUpdate')
                : common('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {showBackups && <ManagerBackups status={status} />}
      <ManagerUpdateProgressDialog
        open={progressOpen}
        onOpenChange={(open) => {
          setProgressOpen(open);
          if (!open) {
            saveManagerUpdateReceipt(null);
            void client.invalidateQueries({ queryKey: componentUpdatesKey });
          }
        }}
        operation={
          progressOperation ??
          (operation?.id !== excludedOperationId ? (operation ?? null) : null)
        }
        pending={mutation.isPending && mutation.variables?.action !== 'plan'}
        requestError={
          mutation.variables?.action !== 'plan'
            ? (mutation.error?.message ?? null)
            : null
        }
        session={progressSession}
        excludedOperationId={excludedOperationId}
        expectedOperationId={
          progressOperation?.id ??
          (progressSession === receipt?.startedAt ? receipt.operationId : null)
        }
      />
    </div>
  );
}
