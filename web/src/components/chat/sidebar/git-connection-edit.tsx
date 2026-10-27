import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectWorkspaceResourceSummary,
} from '@/lib/projects-api';
import { projectConnectionsPath } from '@/lib/project-locations-api';
import { gitInventoryKey } from '@/lib/workspace-git-api';

/** Credentials are write-only: never load, cache or prefill a stored token. */
export function GitConnectionEdit({
  projectId,
  resource,
  disabled,
  onSaved,
}: {
  projectId: string;
  resource: ProjectWorkspaceResourceSummary;
  disabled?: boolean;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation(['workspaces', 'common'], {
    nsMode: 'fallback',
  });
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const submitting = useRef(false);
  const https = resource.address?.startsWith('https://');
  const close = () => {
    if (submitting.current) return;
    setOpen(false);
    setToken('');
    setError(false);
  };
  const save = async () => {
    if (submitting.current || !name.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(false);
    try {
      await projectsApi(
        `${projectConnectionsPath(projectId)}/${encodeURIComponent(resource.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            expectedAddress: resource.address,
            // Omitting secret preserves it server-side. Never send an empty replacement.
            ...(https && token.trim()
              ? { secret: { token: token.trim() } }
              : {}),
          }),
        },
      );
      setToken('');
      setOpen(false);
      setSaved(true);
      await Promise.all([
        onSaved(),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        client.invalidateQueries({ queryKey: ['workspace-git', projectId] }),
        client.invalidateQueries({
          queryKey: ['workspace-git-prs', projectId],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-remote-branches', projectId],
        }),
      ]);
    } catch {
      // Do not render response diagnostics next to a credential field.
      setToken('');
      setError(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const field =
    'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm';
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() => {
          setName(resource.name);
          setToken('');
          setError(false);
          setSaved(false);
          setOpen(true);
        }}
      >
        {t('gitConnectionEdit')}
      </Button>
      {saved && (
        <span role="status" className="text-xs text-muted-foreground">
          {t('gitConnectionSaved')}
        </span>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          className="max-h-[85dvh] overflow-auto"
        >
          <DialogTitle>
            {t('gitConnectionEditTitle', { name: resource.name })}
          </DialogTitle>
          <DialogDescription>{t('gitConnectionEditHelp')}</DialogDescription>
          <form
            className="grid min-w-0 gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="grid gap-1 text-sm">
              {t('connectionName')}
              <input
                className={field}
                value={name}
                disabled={busy}
                maxLength={2048}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              {t('connectionAddress')}
              <input
                className={field}
                value={resource.address ?? ''}
                readOnly
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {resource.hasSecret
                ? t('gitConnectionSecretPresent')
                : t('gitConnectionSecretAbsent')}
            </p>
            {https ? (
              <label className="grid gap-1 text-sm">
                {t('gitConnectionToken')}
                <input
                  className={field}
                  type="password"
                  aria-label={t('gitConnectionToken')}
                  value={token}
                  disabled={busy}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setToken(event.target.value)}
                />
                <span className="text-xs text-muted-foreground">
                  {t('gitConnectionTokenHelp')}
                </span>
              </label>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('gitConnectionHttpsOnly')}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {t('gitConnectionSaveFailed')}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={close}
              >
                {t('gitCopyDeleteCancel')}
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {t('gitConnectionSave')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
