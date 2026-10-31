import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FileActionsMenu } from '@/components/files/file-actions-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  saveLogRetentionRule,
  type LogStorage,
  type LogRetentionPolicy,
} from '@/lib/logs-api';
import { logSizeLabel } from '@/lib/log-storage-size';

type Family = LogStorage['files'][number]['family'];
function useLogNames() {
  const { t } = useTranslation('logs');
  return {
    application: t('logApplicationName'),
    codex: t('logCodexName'),
    other: t('logOtherName'),
  };
}
const patterns = { application: 'app.*.log', codex: 'codex-jsonrpc*.jsonl' };

export function LogRetentionDialog({
  storage,
  onClose,
}: {
  storage: LogStorage;
  onClose: () => void;
}) {
  const { t } = useTranslation(['logs', 'common']);
  const names = useLogNames();
  const [selected, setSelected] = useState<Family | null>(null);
  const actionCells = useRef<Partial<Record<Family, HTMLTableCellElement>>>({});
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90dvh] min-h-0 overflow-y-auto sm:max-w-5xl"
        // Keep the table and its focus target mounted, but do not stack two
        // translucent glass surfaces behind the portalled family editor.
        style={{ display: selected ? 'none' : undefined }}
      >
        <DialogHeader>
          <DialogTitle>{t('logRetentionSettings')}</DialogTitle>
          <DialogDescription>{t('logRetentionHelp')}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">
          {t('logStorageEstimate', {
            size: logSizeLabel(storage.estimatedBytes),
          })}
        </p>
        <div
          className="overflow-x-auto rounded-lg border"
          role="region"
          aria-label={t('logRetentionTable')}
          tabIndex={0}
        >
          <table className="w-full min-w-[48rem] text-left text-sm">
            <caption className="sr-only">{t('logRetentionTable')}</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                {[
                  t('logType'),
                  t('logAutomaticRetention'),
                  t('logArchiveCount'),
                  t('logArchiveAge'),
                  t('logRotation'),
                  t('logTotalSize'),
                  t('logActions'),
                ].map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="px-3 py-3 font-medium last:sticky last:right-0 last:bg-popover"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {(['application', 'codex', 'other'] as const)
                .filter(
                  (family) =>
                    family !== 'other' ||
                    storage.files.some((file) => file.family === 'other'),
                )
                .map((family) => {
                  const files = storage.files.filter(
                    (file) => file.family === family,
                  );
                  const rule =
                    family === 'other' ? null : storage.policy[family];
                  const archives = files.filter((file) => !file.active).length;
                  const bytes = files.reduce(
                    (sum, file) => sum + file.bytes,
                    0,
                  );
                  const rotation =
                    family === 'application'
                      ? 10
                      : family === 'codex' && rule?.enabled
                        ? storage.policy.codex.maxFileMiB
                        : null;
                  const oversized =
                    family === 'codex' &&
                    files.some(
                      (file) =>
                        !file.active &&
                        file.bytes >
                          storage.policy.codex.maxFileMiB * 1024 ** 2,
                    );
                  return (
                    <tr key={family}>
                      <th
                        scope="row"
                        className="max-w-64 px-3 py-3 font-medium"
                      >
                        {names[family]}
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {family === 'other'
                            ? t('logUnmanagedFiles')
                            : patterns[family]}
                        </span>
                        {oversized && (
                          <span className="mt-1 block text-xs font-normal text-amber-700 dark:text-amber-300">
                            {t('logOversizedArchive')}
                          </span>
                        )}
                      </th>
                      <td className="px-3 py-3">
                        <Badge
                          variant={rule?.enabled ? 'secondary' : 'outline'}
                        >
                          {t(
                            rule
                              ? rule.enabled
                                ? 'logRetentionEnabled'
                                : 'logRetentionDisabled'
                              : 'logRetentionUnmanaged',
                          )}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        {rule ? `${archives} / ${rule.maxFiles}` : '—'}
                      </td>
                      <td className="px-3 py-3">
                        {rule ? t('logDays', { count: rule.maxAgeDays }) : '—'}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {rotation ? `${rotation} MiB` : '—'}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                        {logSizeLabel(bytes)}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t('logFileCount', { count: files.length })}
                        </span>
                      </td>
                      <td
                        className="sticky right-0 bg-popover px-3 py-3"
                        ref={(cell) => {
                          if (cell) actionCells.current[family] = cell;
                          else delete actionCells.current[family];
                        }}
                      >
                        <FileActionsMenu
                          buttonLabel={names[family]}
                          actions={[
                            {
                              id: 'configure',
                              label: t(rule ? 'logConfigure' : 'logViewFiles'),
                              icon: rule ? Settings2 : FileText,
                              onSelect: () => setSelected(family),
                            },
                          ]}
                        >
                          <span className="sr-only">{names[family]}</span>
                        </FileActionsMenu>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('logRetentionTableHelp')}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close', { ns: 'common' })}
          </Button>
        </DialogFooter>
        {selected && (
          <LogFamilyDialog
            key={selected}
            family={selected}
            storage={storage}
            onClose={() => setSelected(null)}
            onReturnFocus={() =>
              requestAnimationFrame(() =>
                actionCells.current[selected]?.querySelector('button')?.focus(),
              )
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LogFamilyDialog({
  family,
  storage,
  onClose,
  onReturnFocus,
}: {
  family: Family;
  storage: LogStorage;
  onClose: () => void;
  onReturnFocus: () => void;
}) {
  const { t, i18n } = useTranslation(['logs', 'common']);
  const names = useLogNames();
  const client = useQueryClient();
  const [rule, setRule] = useState<
    (LogRetentionPolicy['application'] & { maxFileMiB?: number }) | null
  >(() =>
    family === 'other' ? null : structuredClone(storage.policy[family]),
  );
  const mutation = useMutation({
    mutationFn: () => {
      if (family === 'other' || !rule) throw new Error('Unmanaged log family');
      return saveLogRetentionRule(family, rule);
    },
    onSuccess: ({ policy }) => {
      client.setQueryData<LogStorage>(['log-storage'], (previous) => ({
        ...(previous ?? storage),
        policy,
      }));
      void client.invalidateQueries({ queryKey: ['log-storage'] });
      onClose();
    },
  });
  const files = storage.files
    .filter((file) => file.family === family)
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        b.modifiedAt - a.modifiedAt ||
        a.name.localeCompare(b.name),
    );
  const oversized =
    family === 'codex' &&
    files.some(
      (file) =>
        !file.active &&
        file.bytes > storage.policy.codex.maxFileMiB * 1024 ** 2,
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !mutation.isPending && onClose()}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!mutation.isPending}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t('logFamilySettings', { name: names[family] })}
          </DialogTitle>
          <DialogDescription>
            {t(
              family === 'application'
                ? 'logApplicationDescription'
                : family === 'codex'
                  ? 'logCodexDescription'
                  : 'logOtherDescription',
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (rule) mutation.mutate();
          }}
        >
          {rule && (
            <fieldset className="space-y-3" disabled={mutation.isPending}>
              <legend className="sr-only">{t('logConfigure')}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) =>
                    setRule({ ...rule, enabled: event.target.checked })
                  }
                />
                {t('enableLogRetention')}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  {t('logRetentionDays')}
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    required
                    value={rule.maxAgeDays}
                    onChange={(event) =>
                      setRule({
                        ...rule,
                        maxAgeDays: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {t('logRetentionFiles')}
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    required
                    value={rule.maxFiles}
                    onChange={(event) =>
                      setRule({ ...rule, maxFiles: Number(event.target.value) })
                    }
                  />
                </label>
                {family === 'codex' && 'maxFileMiB' in rule && (
                  <label className="grid gap-1 text-sm">
                    {t('logRotationMiB')}
                    <Input
                      type="number"
                      min={1}
                      max={1024}
                      required
                      value={rule.maxFileMiB}
                      onChange={(event) =>
                        setRule({
                          ...rule,
                          maxFileMiB: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  family === 'application'
                    ? 'logApplicationRotation'
                    : 'logCodexRotationHelp',
                )}
              </p>
            </fieldset>
          )}
          {oversized && (
            <p
              role="note"
              className="rounded-lg border border-amber-500/40 p-3 text-sm"
            >
              {t('logOversizedArchiveHelp')}
            </p>
          )}
          <section className="space-y-2" aria-label={t('logFiles')}>
            <h3 className="text-sm font-medium">
              {t('logFiles')} ·{' '}
              {logSizeLabel(files.reduce((sum, file) => sum + file.bytes, 0))}
            </h3>
            <ul className="max-h-52 space-y-2 overflow-y-auto rounded-lg border p-3 text-xs">
              {files.length === 0 && <li>{t('logNoFiles')}</li>}
              {files.map((file) => (
                <li key={file.name} className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="break-all">{file.name}</span>
                    <span className="mt-1 block text-muted-foreground">
                      {file.active
                        ? t('logActiveFile')
                        : family === 'other'
                          ? t('logRetentionUnmanaged')
                          : t('logArchiveFile')}{' '}
                      ·{' '}
                      {new Date(file.modifiedAt).toLocaleString(i18n.language)}
                    </span>
                  </div>
                  <span className="shrink-0 tabular-nums">
                    {logSizeLabel(file.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {rule && (
            <p className="text-xs text-muted-foreground">
              {t('logRetentionDeletionWarning')}
            </p>
          )}
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('logRetentionSaveFailed')}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={onClose}
            >
              {t(rule ? 'cancel' : 'close', { ns: 'common' })}
            </Button>
            {rule && (
              <Button type="submit" disabled={mutation.isPending}>
                {t('save', { ns: 'common' })}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
