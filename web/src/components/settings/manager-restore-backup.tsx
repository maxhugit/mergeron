import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { translationKey } from '@/locales/translation-key';
import { backupDescription } from './manager-backup-policy';
import { ManagerUpdateProgressDialog } from './manager-update-progress-dialog';
import { saveManagerUpdateReceipt } from './manager-update-recovery';
import {
  requestManagerUpdate,
  managerStatusQueryKey,
  managerBackupsQueryKey,
  managerHistoryKey,
  type ManagerBackup,
  type ManagerUpdatePlan,
  type ManagerUpdateOperation,
} from './manager-status-api';

export function ManagerRestoreBackup({
  backup,
  onClose,
}: {
  backup: ManagerBackup | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('manager');
  const client = useQueryClient();
  const [plan, setPlan] = useState<ManagerUpdatePlan | null>(null);
  const [ack, setAck] = useState(false);
  const [progress, setProgress] = useState(false);
  const [session, setSession] = useState(0);
  const [operation, setOperation] = useState<ManagerUpdateOperation | null>(
    null,
  );
  const mutation = useMutation({
    mutationFn: ({
      action,
      input,
    }: {
      action: 'restore-plan' | 'restore' | 'checkpoint-plan' | 'checkpoint';
      input: Record<string, unknown>;
    }) => requestManagerUpdate(action, input),
    onSuccess: (result) => {
      if ('applicable' in result) {
        setPlan(result);
        setAck(false);
      }
      if ('operation' in result) {
        setOperation(result.operation);
        const now = Date.now();
        saveManagerUpdateReceipt({
          startedAt: now,
          operationId: result.operation?.id ?? null,
          excludedOperationId: null,
        });
      }
      void client.invalidateQueries({ queryKey: managerStatusQueryKey });
    },
  });
  return (
    <>
      <Dialog
        open={!progress}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) onClose();
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t(backup ? 'restoreBackupTitle' : 'createBackupTitle')}
            </DialogTitle>
            <DialogDescription>
              {backup
                ? new Date(backup.createdAt).toLocaleString(i18n.language) +
                  ' · ' +
                  backup.id
                : t('createBackupWarning')}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-3 overflow-auto text-sm">
            <p>
              {t(
                translationKey(
                  backupDescription(backup?.backupPolicy ?? 'full-v1'),
                ),
              )}
            </p>
            {backup && <p>{t('restoreBackupWarning')}</p>}
            <p className="font-medium">
              {t(backup ? 'restoreSafetyBackup' : 'createBackupWarning')}
            </p>
            {plan && (
              <>
                <p className="break-all font-mono text-xs">
                  {Object.entries(plan.images)
                    .map(([id, image]) => `${id}: ${image}`)
                    .join('\n')}
                </p>
                {!plan.applicable && (
                  <p role="alert" className="text-destructive">
                    {t('managerUpdateBlocked')} {plan.blockers.join(', ')}
                  </p>
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  {t(
                    backup
                      ? 'restoreBackupAcknowledgement'
                      : 'createBackupAcknowledgement',
                  )}
                </label>
              </>
            )}
            {mutation.isError && (
              <p role="alert" className="text-destructive">
                {t(translationKey(mutation.error.message))}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={onClose}
            >
              {t('managerBackupCancel')}
            </Button>
            {!plan ? (
              <Button
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    action: backup ? 'restore-plan' : 'checkpoint-plan',
                    input: { operationId: backup?.id },
                  })
                }
              >
                {t(backup ? 'restoreBackupReview' : 'createBackupReview')}
              </Button>
            ) : (
              <Button
                disabled={mutation.isPending || !plan.applicable || !ack}
                onClick={() => {
                  const now = Date.now();
                  saveManagerUpdateReceipt({
                    startedAt: now,
                    operationId: null,
                    excludedOperationId: null,
                  });
                  setSession(now);
                  setProgress(true);
                  mutation.mutate({
                    action: backup ? 'restore' : 'checkpoint',
                    input: {
                      operationId: backup?.id,
                      confirmation: backup
                        ? 'RESTORE_SAVED_STATE'
                        : 'CREATE_BACKUP',
                      expectedFingerprint: plan.fingerprint,
                    },
                  });
                }}
              >
                {t(backup ? 'restoreBackupConfirm' : 'createBackupTitle')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ManagerUpdateProgressDialog
        open={progress}
        onOpenChange={(open) => {
          setProgress(open);
          if (!open) {
            saveManagerUpdateReceipt(null);
            void client.invalidateQueries({ queryKey: managerBackupsQueryKey });
            void client.invalidateQueries({ queryKey: managerHistoryKey });
            onClose();
          }
        }}
        operation={operation}
        pending={mutation.isPending}
        requestError={mutation.isError ? mutation.error.message : null}
        session={session}
        excludedOperationId={null}
      />
    </>
  );
}
