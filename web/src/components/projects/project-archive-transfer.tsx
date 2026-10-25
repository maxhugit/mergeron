import { useEffect, useState } from 'react';
import { Download, Loader2, Upload } from 'lucide-react';
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

export function ProjectArchiveExport({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
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
  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <h3 className="font-semibold">{t('projectArchiveTitle')}</h3>
      <p className="text-sm text-muted-foreground">
        {t('projectArchiveExportDescription')}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('projectArchiveSensitive')}
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void download()}>
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Download className="mr-2 h-4 w-4" />
        )}
        {t(busy ? 'projectArchiveExporting' : 'projectArchiveExport')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** Available without creating a destination project first. */
export function ProjectArchiveImportButton() {
  const session = usePlatformSession();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [name, setName] = useState('');
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
    try {
      const form = new FormData();
      form.append('archive', file);
      const response = await archiveRequest('/preview', {
        method: 'POST',
        body: form,
      });
      const result = (await response.json()) as ArchivePreview;
      setPreview(result);
      setName(
        (result.projectName + t('projectArchiveImportedSuffix')).slice(0, 200),
      );
    } catch (reason) {
      setError(archiveError(reason, t('projectArchivePreviewError')));
    } finally {
      setBusy(null);
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
    setError('');
    try {
      const response = await archiveRequest('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: preview.token, name: name.trim() }),
      });
      const result = (await response.json()) as { projectId: string };
      await client.invalidateQueries({ queryKey: projectsQueryKey });
      await client.invalidateQueries({ queryKey: ['threads'] });
      setOpen(false);
      setPreview(null);
      void navigate({
        to: '/projects/$projectId',
        params: { projectId: result.projectId },
      });
    } catch (reason) {
      setPreview(null); // tokens are single-use; never replay a failed POST automatically
      setError(archiveError(reason, t('projectArchiveImportError')));
    } finally {
      setBusy(null);
    }
  };
  if (!session.isAdministrator) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          if (!value) {
            setPreview(null);
            setError('');
          }
        }
      }}
    >
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        aria-label={t('projectArchiveImport')}
        title={t('projectArchiveImport')}
        onClick={() => setOpen(true)}
      >
        <Upload className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('projectArchiveImport')}</DialogTitle>
            <DialogDescription>
              {t('projectArchiveImportDescription')}
            </DialogDescription>
          </DialogHeader>
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
                setOpen(false);
                setPreview(null);
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
        </DialogContent>
      )}
    </Dialog>
  );
}
