import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { translationKey } from '@/locales/translation-key';
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
    refetchInterval: (query) =>
      query.state.data?.sizesCalculating ? 2_000 : 30_000,
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
    <section className="space-y-3" aria-label={t('managerBackupsTitle')}>
      <h3 className="font-medium">{t('managerBackupsTitle')}</h3>
      <p className="text-xs text-muted-foreground">{t('managerBackupsHelp')}</p>
      {query.data && (
        <p className="text-sm font-medium">
          {t('managerBackupsTotalSize', {
            size:
              query.data.totalSizeBytes == null && query.data.sizesCalculating
                ? t('managerBackupSizeCalculating')
                : size(query.data.totalSizeBytes),
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
          <div className="max-h-[65vh] overflow-auto">
            <table
              className="w-full min-w-[800px] table-fixed text-left text-sm"
              aria-label={t('managerBackupsTitle')}
            >
              <colgroup>
                <col className="w-[12%]" />
                <col className="w-[17%]" />
                <col className="w-[28%]" />
                <col className="w-[10%]" />
                <col className="w-[15%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b">
                  {(
                    [
                      'managerBackupDateColumn',
                      'managerBackupIdColumn',
                      'managerBackupHostPath',
                      'managerBackupSizeColumn',
                      'managerBackupStatusColumn',
                      'managerBackupActionsColumn',
                    ] as const
                  ).map((key) => (
                    <th key={key} scope="col" className="px-3 py-2 font-medium">
                      {t(translationKey(key))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {query.data?.backups.map((backup) => (
                  <tr key={backup.id} className="align-top">
                    <td className="px-3 py-3">
                      <time dateTime={backup.createdAt}>
                        {date(backup.createdAt)}
                      </time>
                    </td>
                    <td className="px-3 py-3">
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {backup.id}
                      </p>
                    </td>
                    <td className="px-3 py-3">
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
                    </td>
                    <td className="break-words px-3 py-3">
                      <p className="text-xs">
                        {t('managerBackupDiskSize', {
                          size:
                            backup.sizeStatus === 'calculating'
                              ? t('managerBackupSizeCalculating')
                              : size(backup.sizeBytes),
                        })}
                      </p>
                    </td>
                    <td className="break-words px-3 py-3">
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
                    </td>
                    <td className="px-3 py-3">
                      <Button
                        variant="outline"
                        className="h-auto min-h-8 w-full whitespace-normal break-words px-2 py-2 text-xs"
                        disabled={busy || !backup.canDelete}
                        onClick={() => {
                          deletion.reset();
                          setSelected(backup);
                        }}
                      >
                        {t('managerBackupDelete')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
