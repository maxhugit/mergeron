import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { projectsApi, projectsQueryKey } from '@/lib/projects-api';
import { translationKey } from '@/locales/translation-key';

type Options = {
  boardId: string;
  copyId: string;
  directory: string;
  restrictedIds: string[];
};
type Settings = Omit<Options, 'boardId'> & {
  enabled: boolean;
  lastError: string | null;
  lastSyncAt: number | null;
};
interface Status {
  boards: {
    id: string;
    name: string;
    restricted: { id: string; title: string }[];
    settings: Settings | null;
  }[];
  copies: {
    id: string;
    name: string;
    writable: boolean;
    owned: boolean;
    directory?: string;
  }[];
  discovered: { id: string; title: string; documents: number }[];
  discoveryError: string | null;
}
type Preview = {
  fingerprint: string;
  canApply: boolean;
  changes: {
    deliverable: string;
    document?: string;
    action: string;
    reason: string;
  }[];
};
const url = (p: string) => `/${encodeURIComponent(p)}/git-deliverables`;
const key = (p: string) => ['git-deliverables', p];
const suffix = (value: string) =>
  value
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
const post = <T,>(p: string, suffix: string, body: unknown) =>
  projectsApi<T>(url(p) + suffix, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export function GitDeliverablesSettings({
  projectId,
  preferredCopyId,
}: {
  projectId: string;
  preferredCopyId?: string;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('');
  const query = useQuery({
    queryKey: key(projectId),
    queryFn: () => projectsApi<Status>(url(projectId)),
    staleTime: 30_000,
    retry: false,
  });
  const board =
    query.data?.boards.find((b) => b.id === selected) ?? query.data?.boards[0];
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
      {!board ? (
        <p>{t('gitDeliverablesNoBoard')}</p>
      ) : (
        <>
          <label className="grid gap-1 text-sm">
            {t('gitDeliverablesBoard')}
            <select
              className="w-full rounded-md border bg-background p-2"
              value={board.id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {query.data.boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
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
  const { t } = useTranslation();
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(board.settings?.enabled ?? false);
  const [copyId, setCopy] = useState(
    board.settings?.copyId ??
      preferredCopyId ??
      copies.find((c) => c.writable && !c.owned)?.id ??
      '',
  );
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
    mutationFn: async (action: 'preview' | 'apply' | 'disable') => {
      setSuccess(false);
      if (action === 'preview') {
        setPreview(await post<Preview>(projectId, '/preview', options));
        return;
      }
      if (action === 'apply') {
        if (!preview) return;
        await post(projectId, '/apply', {
          options,
          fingerprint: preview.fingerprint,
        });
      } else
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
      <fieldset disabled={mutation.isPending} className="min-w-0 space-y-3">
        <label className="grid gap-1 text-sm">
          {t('gitDeliverablesCopy')}
          <select
            disabled={!enabled}
            className="w-full rounded-md border bg-background p-2"
            value={copyId}
            onChange={(e) => {
              setCopy(e.target.value);
              setDirectory(
                copies.find((c) => c.id === e.target.value)?.directory ??
                  'livrables',
              );
              dirty();
            }}
          >
            <option value="">{t('gitDeliverablesChooseCopy')}</option>
            {copies.map((c) => (
              <option disabled={!c.writable || c.owned} key={c.id} value={c.id}>
                {c.name}
                {!c.writable || c.owned
                  ? ` · ${t('gitDeliverablesIneligibleCopy')}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
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
          disabled={mutation.isPending || (enabled && (!copyId || !directory))}
          onClick={() => mutation.mutate(enabled ? 'preview' : 'disable')}
        >
          {t('gitDeliverablesPreview')}
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

/** Read-only recognition when a repository is opened; imports stay explicit. */
export function GitDeliverablesDiscovery({
  projectId,
  copyId,
  inspectedAt,
}: {
  projectId: string;
  copyId: string;
  inspectedAt?: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: [...key(projectId), 'discovery', copyId, inspectedAt],
    queryFn: () =>
      projectsApi<Status>(
        url(projectId) + `?copyId=${encodeURIComponent(copyId)}`,
      ),
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
  });
  const active = query.data?.boards?.some(
    (b) => b.settings?.enabled && b.settings.copyId === copyId,
  );
  if (!active && !query.data?.discovered?.length && !query.data?.discoveryError)
    return null;
  return (
    <section className="shrink-0 space-y-2 border-b p-2 text-xs">
      <p>
        {active
          ? t('gitDeliverablesActive')
          : t('gitDeliverablesDetected', {
              count: query.data?.discovered?.length ?? 0,
            })}
      </p>
      {query.data?.discoveryError && (
        <p role="alert">{t('gitDeliverablesUnavailable')}</p>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t('gitDeliverablesReview')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('gitDeliverablesTitle')}</DialogTitle>
          </DialogHeader>
          <GitDeliverablesSettings
            projectId={projectId}
            preferredCopyId={copyId}
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
