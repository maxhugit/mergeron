import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { projectsApi, projectsQueryKey } from '@/lib/projects-api';
import { translationKey } from '@/locales/translation-key';

import {
  key,
  url,
  post,
  suffix,
  type Preview,
  type Status,
} from '@/lib/git-deliverables-api';

export function GitDeliverablesSettings({
  projectId,
  preferredCopyId,
}: {
  projectId: string;
  preferredCopyId?: string;
}) {
  const { t } = useTranslation(['workspaces', 'common'], {
    nsMode: 'fallback',
  });
  const query = useQuery({
    queryKey: key(projectId),
    queryFn: () => projectsApi<Status>(url(projectId)),
    staleTime: 30_000,
    retry: false,
  });
  const board = query.data?.boards[0];
  if (query.error) return <p role="alert">{t('gitDeliverablesUnavailable')}</p>;
  if (!query.data) return <p>{t('loading')}</p>;
  return (
    <section className="min-w-0 space-y-4">
      <header>
        <h3 className="font-semibold">{t('gitDeliverablesTitle')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('gitDeliverablesDescription')}
        </p>
      </header>
      {query.data.boards.length > 1 ? (
        <p role="alert">{t('gitDeliverablesAmbiguousBoard')}</p>
      ) : !board ? (
        <p>{t('gitDeliverablesNoBoard')}</p>
      ) : (
        <>
          <GitDeliverablesConfiguration
            key={board.id}
            projectId={projectId}
            board={board}
            copies={query.data.copies}
            preferredCopyId={preferredCopyId}
          />
        </>
      )}
    </section>
  );
}

function GitDeliverablesConfiguration({
  projectId,
  board,
  copies,
  preferredCopyId,
}: {
  projectId: string;
  board: Status['boards'][number];
  copies: Status['copies'];
  preferredCopyId?: string;
}) {
  const { t } = useTranslation(['workspaces', 'common'], {
    nsMode: 'fallback',
  });
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(board.settings?.enabled ?? false);
  const copyId = preferredCopyId;
  const eligible = copies.filter((c) => c.eligible);
  const available = copyId
    ? eligible.some((c) => c.id === copyId)
    : eligible.length > 0;
  const [directory, setDirectory] = useState(
    board.settings?.directory ??
      copies.find((c) => c.id === copyId)?.directory ??
      'livrables',
  );
  const [restrictedIds, setRestricted] = useState(
    board.settings?.restrictedIds ?? [],
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [adoptFolders, setAdoptFolders] = useState(false);
  const [success, setSuccess] = useState(false);
  const options = {
    boardId: board.id,
    copyId,
    directory,
    restrictedIds,
    adoptFolders,
  };
  const mutation = useMutation({
    mutationFn: async (
      action: 'preview' | 'apply' | 'disable' | 'configure',
    ) => {
      setSuccess(false);
      if (action === 'configure') {
        await post(projectId, '/configure', {
          boardId: board.id,
          enabled,
          directory,
          restrictedIds,
        });
      } else if (action === 'preview') {
        setPreview(await post<Preview>(projectId, '/preview', options));
        return;
      } else if (action === 'apply') {
        if (!preview) return;
        await post(projectId, '/apply', {
          options,
          fingerprint: preview.fingerprint,
        });
      } else if (action === 'disable')
        await post(projectId, `/${encodeURIComponent(board.id)}/disable`, {});
      setPreview(null);
      setSuccess(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: key(projectId) }),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
        client.invalidateQueries({ queryKey: ['deliverables'] }),
        client.invalidateQueries({ queryKey: ['workspace-git'] }),
      ]);
    },
  });
  const dirty = () => {
    setPreview(null);
    setSuccess(false);
    mutation.reset();
  };
  return (
    <div className="min-w-0 space-y-4">
      <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <span>{t('gitDeliverablesEnable')}</span>
        <Switch
          checked={enabled}
          disabled={mutation.isPending}
          onCheckedChange={(v) => {
            setEnabled(v);
            dirty();
          }}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t('gitDeliverablesAgentCopies')}
      </p>
      {!available && (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/50 p-3 text-sm"
        >
          {t('gitDeliverablesMissingAgentCopy')}
        </p>
      )}
      <fieldset disabled={mutation.isPending} className="min-w-0 space-y-3">
        <label className="grid gap-1 text-sm">
          {t('gitDeliverablesDirectory')}
          <input
            disabled={!enabled}
            className="w-full rounded-md border bg-background p-2"
            value={directory}
            onChange={(e) => {
              setDirectory(e.target.value);
              dirty();
            }}
          />
        </label>
        {board.restricted.length > 0 && (
          <fieldset className="space-y-2 rounded-lg border border-amber-500/50 p-3">
            <legend>{t('gitDeliverablesRestricted')}</legend>
            <p className="text-sm text-muted-foreground">
              {t('gitDeliverablesRestrictedWarning')}
            </p>
            {board.restricted.map((d) => (
              <label key={d.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!enabled}
                  checked={restrictedIds.includes(d.id)}
                  onChange={(e) => {
                    setRestricted(
                      e.target.checked
                        ? [...restrictedIds, d.id]
                        : restrictedIds.filter((id) => id !== d.id),
                    );
                    dirty();
                  }}
                />
                <span className="break-words">{d.title}</span>
              </label>
            ))}
          </fieldset>
        )}
      </fieldset>
      {copyId && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={adoptFolders}
            disabled={!enabled || mutation.isPending}
            onChange={(e) => {
              setAdoptFolders(e.target.checked);
              dirty();
            }}
          />
          <span>{t('gitDeliverablesAdoptFolders')}</span>
        </label>
      )}
      <p className="text-sm text-muted-foreground">
        {t('gitDeliverablesGuarantees')}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('gitDeliverablesLargeFiles')}
      </p>
      {board.settings?.lastError && (
        <p role="alert" className="break-words text-amber-600">
          {t('gitDeliverablesSyncNeedsReview')}{' '}
          <code>{board.settings.lastError}</code>
        </p>
      )}
      {board.settings?.lastSyncAt && (
        <p className="text-xs text-muted-foreground">
          {t('gitDeliverablesLastSync')}{' '}
          {new Date(board.settings.lastSyncAt).toLocaleString()}
        </p>
      )}
      {mutation.error && (
        <p role="alert" className="break-words text-destructive">
          {t('gitDeliverablesOperationFailed')}{' '}
          <code>{mutation.error.message}</code>
        </p>
      )}
      {success && <p role="status">{t('gitDeliverablesSaved')}</p>}
      {preview && (
        <section
          className="space-y-2 rounded-lg border p-3"
          aria-label={t('gitDeliverablesPreview')}
        >
          <h4 className="font-medium">{t('gitDeliverablesPreview')}</h4>
          {!preview.changes.length && <p>{t('gitDeliverablesNoChanges')}</p>}
          <ul className="divide-y">
            {preview.changes.map((change, i) => (
              <li key={i} className="min-w-0 py-2 text-sm">
                <span
                  className={
                    change.action === 'conflict'
                      ? 'font-medium text-amber-600'
                      : 'font-medium'
                  }
                >
                  {t(
                    translationKey(
                      change.action === 'conflict'
                        ? 'transferActionConflict'
                        : `gitDeliverablesAction${suffix(change.action)}`,
                    ),
                  )}
                </span>{' '}
                ·{' '}
                <span className="break-words">
                  {change.deliverable}
                  {change.document ? ` / ${change.document}` : ''}
                </span>
                <p className="text-muted-foreground">
                  {t(
                    translationKey(
                      `gitDeliverablesReason${suffix(change.reason)}`,
                    ),
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t bg-background py-3">
        {preview && (
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => setPreview(null)}
          >
            {t('cancel')}
          </Button>
        )}
        <Button
          disabled={
            mutation.isPending || (enabled && (!available || !directory))
          }
          onClick={() =>
            mutation.mutate(
              !copyId ? 'configure' : enabled ? 'preview' : 'disable',
            )
          }
        >
          {t(copyId ? 'gitDeliverablesPreview' : 'gitDeliverablesSaveMode')}
        </Button>
        {preview && enabled && (
          <Button
            disabled={!preview.canApply || mutation.isPending}
            onClick={() => mutation.mutate('apply')}
          >
            {t('gitDeliverablesConfirm')}
          </Button>
        )}
      </div>
    </div>
  );
}
