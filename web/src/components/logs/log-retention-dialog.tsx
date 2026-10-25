import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
  saveLogRetention,
  type LogStorage,
  type LogRetentionPolicy,
} from '@/lib/logs-api';

import { logSizeLabel } from '@/lib/log-storage-size';
export function LogRetentionDialog({
  storage,
  onClose,
}: {
  storage: LogStorage;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [policy, setPolicy] = useState<LogRetentionPolicy>(() =>
    structuredClone(storage.policy),
  );
  const mutation = useMutation({
    mutationFn: () => saveLogRetention(policy),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['log-storage'] });
      onClose();
    },
  });
  const description = (family: 'application' | 'codex' | 'other') =>
    t(
      family === 'application'
        ? 'logApplicationDescription'
        : family === 'codex'
          ? 'logCodexDescription'
          : 'logOtherDescription',
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('logRetentionSettings')}</DialogTitle>
          <DialogDescription>{t('logRetentionHelp')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          {(['application', 'codex'] as const).map((family) => (
            <fieldset
              key={family}
              className="space-y-3 rounded-lg border p-3"
              disabled={mutation.isPending}
            >
              <legend className="px-1 font-medium">
                {family === 'application'
                  ? 'app.*.log'
                  : 'codex-jsonrpc*.jsonl'}
              </legend>
              <p className="text-sm text-muted-foreground">
                {description(family)}
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={policy[family].enabled}
                  onChange={(event) =>
                    setPolicy({
                      ...policy,
                      [family]: {
                        ...policy[family],
                        enabled: event.target.checked,
                      },
                    })
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
                    value={policy[family].maxAgeDays}
                    onChange={(event) =>
                      setPolicy({
                        ...policy,
                        [family]: {
                          ...policy[family],
                          maxAgeDays: Number(event.target.value),
                        },
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
                    value={policy[family].maxFiles}
                    onChange={(event) =>
                      setPolicy({
                        ...policy,
                        [family]: {
                          ...policy[family],
                          maxFiles: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                {family === 'codex' && (
                  <label className="grid gap-1 text-sm">
                    {t('logRotationMiB')}
                    <Input
                      type="number"
                      min={1}
                      max={1024}
                      required
                      value={policy.codex.maxFileMiB}
                      onChange={(event) =>
                        setPolicy({
                          ...policy,
                          codex: {
                            ...policy.codex,
                            maxFileMiB: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                )}
              </div>
              {family === 'application' && (
                <p className="text-xs text-muted-foreground">
                  {t('logApplicationRotation')}
                </p>
              )}
              <ul className="space-y-1 text-xs">
                {storage.files
                  .filter((file) => file.family === family)
                  .map((file) => (
                    <li key={file.name} className="flex min-w-0 gap-2">
                      <span className="min-w-0 flex-1 break-all">
                        {file.name}
                        {file.active ? ` · ${t('logActiveFile')}` : ''}
                      </span>
                      <span className="shrink-0">
                        {logSizeLabel(file.bytes)}
                      </span>
                    </li>
                  ))}
              </ul>
            </fieldset>
          ))}
          {storage.files.some((file) => file.family === 'other') && (
            <div className="space-y-1 text-sm">
              <p>{description('other')}</p>
              {storage.files
                .filter((file) => file.family === 'other')
                .map((file) => (
                  <p key={file.name}>
                    {file.name} · {logSizeLabel(file.bytes)}
                  </p>
                ))}
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t('logRetentionDeletionWarning')}
          </p>
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
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
