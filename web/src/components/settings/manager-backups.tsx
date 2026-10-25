import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
import {
  deleteManagerBackup,
  managerBackupsQueryKey,
  managerStatusQueryKey,
  requestManagerBackups,
  type ManagerBackup,
  type ManagerStatus,
} from './manager-status-api';

export function ManagerBackups({ status }: { status: ManagerStatus }) {
  const { t, i18n } = useTranslation('manager');
  const client = useQueryClient();
  const [selected, setSelected] = useState<ManagerBackup | null>(null);
  const supported = status.capabilities?.backupManagement === true;
  const query = useQuery({
    queryKey: managerBackupsQueryKey,
    queryFn: requestManagerBackups,
    enabled: supported,
    refetchInterval: 30_000,
    retry: false,
  });
  const deletion = useMutation({
    mutationFn: (id: string) => deleteManagerBackup(id),
    onSuccess: async () => {
      setSelected(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: managerBackupsQueryKey }),
        client.invalidateQueries({ queryKey: managerStatusQueryKey }),
      ]);
    },
  });
  const busy = Boolean(status.update?.busy || deletion.isPending);
  const date = (value: string) => new Date(value).toLocaleString(i18n.language);
  const size = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value))
      return t('managerBackupSizeUnknown');
    const unit =
      value < 1024
        ? 0
        : Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
    const units = i18n.language.startsWith('fr')
      ? ['o', 'Kio', 'Mio', 'Gio']
      : ['B', 'KiB', 'MiB', 'GiB'];
    return `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value / 1024 ** unit)} ${units[unit]}`;
  };
  return (
    <section
      className="space-y-3 border-t pt-4"
      aria-label={t('managerBackupsTitle')}
    >
      <h3 className="font-medium">{t('managerBackupsTitle')}</h3>
      <p className="text-xs text-muted-foreground">{t('managerBackupsHelp')}</p>
      {query.data && (
        <p className="text-sm font-medium">
          {t('managerBackupsTotalSize', {
            size: size(query.data.totalSizeBytes),
          })}
        </p>
      )}
      {!supported ? (
        <p className="text-sm text-muted-foreground">
          {t('managerBackupsUpgradeRequired')}
        </p>
      ) : (
        <>
          {query.isPending && (
            <p className="text-sm">{t('managerBackupsLoading')}</p>
          )}
          {query.isError && (
            <div className="text-sm">
              <p role="alert">{t('managerBackupsUnavailable')}</p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t('managerBackupsRefresh')}
              </Button>
            </div>
          )}
          {query.data?.backups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('managerBackupsEmpty')}
            </p>
          )}
          <ul className="divide-y rounded-lg border">
            {query.data?.backups.map((backup) => (
              <li
                key={backup.id}
                className="flex flex-wrap items-center gap-3 p-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <time dateTime={backup.createdAt}>
                    {date(backup.createdAt)}
                  </time>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {backup.id}
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {t(
                      backup.path
                        ? 'managerBackupHostPath'
                        : 'managerBackupManagerPath',
                    )}
                    :{' '}
                    {backup.path ||
                      backup.managerPath ||
                      t('managerBackupSizeUnknown')}
                  </p>
                  <p className="text-xs">
                    {t('managerBackupDiskSize', {
                      size: size(backup.sizeBytes),
                    })}
                  </p>
                  {backup.current && (
                    <p className="text-xs">{t('managerBackupsLatest')}</p>
                  )}
                  {!backup.restorable && (
                    <p className="text-xs text-muted-foreground">
                      {t('managerBackupIncomplete')}
                    </p>
                  )}
                  {backup.protectionReason && (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        backup.protectionReason ===
                          'managerBackupOperationProtected'
                          ? 'managerBackupOperationProtected'
                          : 'managerBackupMetadataProtected',
                      )}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  disabled={busy || !backup.canDelete}
                  onClick={() => {
                    deletion.reset();
                    setSelected(backup);
                  }}
                >
                  {t('managerBackupDelete')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !deletion.isPending) setSelected(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('managerBackupDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('managerBackupDeleteConfirm', {
                date: selected ? date(selected.createdAt) : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletion.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('managerBackupDeleteFailed')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletion.isPending}>
              {t('managerBackupCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !selected?.canDelete}
              onClick={(event) => {
                event.preventDefault();
                if (selected) deletion.mutate(selected.id);
              }}
            >
              {t(
                deletion.isPending
                  ? 'managerBackupDeleting'
                  : 'managerBackupDelete',
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
