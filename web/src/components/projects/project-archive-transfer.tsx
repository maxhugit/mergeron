import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { usePlatformSession } from '@/lib/platform-session';
import { projectsQueryKey } from '@/lib/projects-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ArchivePreview {
  token: string;
  projectName: string;
  sourceVersion: string;
  targetVersion: string;
  files: number;
  bytes: number;
  warnings: string[];
}

function archiveError(reason: unknown, fallback: string) {
  return reason instanceof Error &&
    !(reason instanceof TypeError) &&
    !(reason instanceof SyntaxError)
    ? reason.message
    : fallback;
}

async function archiveRequest(path: string, init?: RequestInit) {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath('/api/project-archives' + path), {
    ...init,
    credentials: 'same-origin',
    redirect: 'error',
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    throw new Error(
      typeof body?.message === 'string'
        ? body.message
        : `HTTP ${response.status}`,
    );
  }
  return response;
}

export function ProjectArchiveExportDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = usePlatformSession();
  const { t } = useTranslation(['common', 'projectArchives'], {
    nsMode: 'fallback',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await archiveRequest(
        `/${encodeURIComponent(projectId)}/export`,
      );
      if (!response.headers.get('content-type')?.includes('application/zip'))
        throw new Error(t('projectArchiveDownloadError'));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'mergeron-project.zip';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      setError(archiveError(reason, t('projectArchiveDownloadError')));
    } finally {
      setBusy(false);
    }
  };
  if (!session.isAdministrator) return null;
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      {open && (
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('projectArchiveTitle')}</DialogTitle>
            <DialogDescription>
              {t('projectArchiveSensitive')}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('projectArchiveExportDescription')}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void download()}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {t(busy ? 'projectArchiveExporting' : 'projectArchiveExport')}
            </Button>
          </DialogFooter>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Available without creating a destination project first. */
export function ProjectArchiveImportForm({
  onBusyChange,
  onImported,
  onCancel,
}: {
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
  onCancel: () => void;
}) {
  const session = usePlatformSession();
  const { t } = useTranslation(['common', 'projectArchives'], {
    nsMode: 'fallback',
  });
  const navigate = useNavigate();
  const client = useQueryClient();
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [name, setName] = useState('');
  const [selection, setSelection] = useState<string[]>([
    'files',
    'conversations',
    'work',
  ]);
  const [error, setError] = useState('');
  const inspect = async (file: File | undefined) => {
    setPreview(null);
    setError('');
    if (!file) return;
    if (file.size > 96 * 1024 * 1024) {
      setError(t('projectArchiveLimit'));
      return;
    }
    setBusy('preview');
    onBusyChange(true);
    try {
      const form = new FormData();
      form.append('archive', file);
      const response = await archiveRequest('/preview', {
        method: 'POST',
        body: form,
      });
      const result = (await response.json()) as ArchivePreview;
      setPreview(result);
      setSelection(['files', 'conversations', 'work']);
      setName(
        (result.projectName + t('projectArchiveImportedSuffix')).slice(0, 200),
      );
    } catch (reason) {
      setError(archiveError(reason, t('projectArchivePreviewError')));
    } finally {
      setBusy(null);
      onBusyChange(false);
    }
  };
  useEffect(() => {
    const token = preview?.token;
    return () => {
      if (token)
        void archiveRequest('/preview/' + encodeURIComponent(token), {
          method: 'DELETE',
        }).catch(() => {});
    };
  }, [preview?.token]);
  const restore = async () => {
    if (!preview) return;
    setBusy('import');
    onBusyChange(true);
    setError('');
    try {
      const response = await archiveRequest('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: preview.token,
          name: name.trim(),
          selection,
        }),
      });
      const result = (await response.json()) as { projectId: string };
      await client.invalidateQueries({ queryKey: projectsQueryKey });
      await client.invalidateQueries({ queryKey: ['threads'] });
      setPreview(null);
      onImported();
      void navigate({
        to: '/projects/$projectId',
        params: { projectId: result.projectId },
      });
    } catch (reason) {
      setPreview(null); // tokens are single-use; never replay a failed POST automatically
      setError(archiveError(reason, t('projectArchiveImportError')));
    } finally {
      setBusy(null);
      onBusyChange(false);
    }
  };
  if (!session.isAdministrator) return null;
  return (
    <div
      className="space-y-4"
      role="tabpanel"
      id="project-import-panel"
      aria-labelledby="project-import-tab"
    >
      <label className="space-y-2 text-sm">
        <span>{t('projectArchiveChooseZip')}</span>
        <Input
          type="file"
          accept=".zip,application/zip"
          disabled={!!busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void inspect(file);
          }}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t('projectArchiveLimit')}
      </p>
      {busy && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t(
            busy === 'preview'
              ? 'projectArchiveAnalyzing'
              : 'projectArchiveImporting',
          )}
        </p>
      )}
      {preview && (
        <div className="space-y-3 text-sm">
          <p className="font-medium">{t('projectArchiveCompatible')}</p>
          <p>
            {t('projectArchiveVersions', {
              source: preview.sourceVersion,
              target: preview.targetVersion,
            })}
          </p>
          <p>
            {t('projectArchiveContents', {
              count: preview.files,
              size: (preview.bytes / 1024 / 1024).toFixed(1),
            })}
          </p>
          <label className="block space-y-2">
            <span>{t('projectArchiveProjectName')}</span>
            <Input
              value={name}
              maxLength={200}
              disabled={!!busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <fieldset
            className="space-y-3 rounded-lg border p-3"
            disabled={!!busy}
          >
            <legend className="px-1 font-medium">
              {t('projectArchiveSelection')}
            </legend>
            <p className="text-muted-foreground">{t('projectArchiveCore')}</p>
            {(['files', 'conversations', 'work'] as const).map((category) => {
              const required =
                category === 'files'
                  ? selection.includes('conversations') ||
                    selection.includes('work')
                  : category === 'conversations' && selection.includes('work');
              return (
                <label key={category} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selection.includes(category)}
                    disabled={!!busy || required}
                    onChange={(event) => {
                      const next = new Set(selection);
                      if (event.target.checked) {
                        next.add(category);
                        if (category === 'work') next.add('conversations');
                        if (category !== 'files') next.add('files');
                      } else next.delete(category);
                      setSelection([...next]);
                    }}
                  />
                  <span>
                    {category === 'files'
                      ? t('projectArchiveBundleFiles')
                      : category === 'conversations'
                        ? t('projectArchiveBundleConversations')
                        : t('projectArchiveBundleWork')}
                    {required && (
                      <span className="block text-xs text-muted-foreground">
                        {t('projectArchiveRequired')}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            <p className="text-muted-foreground">
              {t('projectArchiveDependencies')}
            </p>
          </fieldset>
          <p>{t('projectArchiveSafety')}</p>
          <p>{t('projectArchiveContacts')}</p>
          <p>{t('projectArchiveExpiry')}</p>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="whitespace-pre-wrap text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          variant="outline"
          disabled={!!busy}
          onClick={() => {
            setPreview(null);
            onCancel();
          }}
        >
          {t('cancel')}
        </Button>
        <Button
          disabled={!preview || !!busy || !name.trim()}
          onClick={() => void restore()}
        >
          {t('projectArchiveConfirmImport')}
        </Button>
      </DialogFooter>
    </div>
  );
}
