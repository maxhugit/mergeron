import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Eye, FileText, History, Info, MoreVertical, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FileViewer } from '@/components/files/file-viewer';
import { projectsApi } from '@/lib/projects-api';
import type {
  Deliverable,
  DeliverableDocument,
  DeliverableDocumentVersion,
} from '@/lib/deliverables-api';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

type Props = {
  item: Deliverable;
  base: string;
  disabled: boolean;
  refresh: () => Promise<unknown>;
  onError: () => void;
};

export function DeliverableDocuments({
  item,
  base,
  disabled,
  refresh,
  onError,
}: Props) {
  const { t } = useTranslation();
  const [comment, setComment] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [detail, setDetail] = useState<{
    document: DeliverableDocument;
    tab: 'versions' | 'preview' | 'information';
  } | null>(null);
  const active = useMemo(
    () => item.documents.filter((document) => document.deletedAt === null),
    [item.documents],
  );
  const archived = useMemo(
    () => item.documents.filter((document) => document.deletedAt !== null),
    [item.documents],
  );

  const request = useMutation({
    mutationFn: ({
      suffix,
      method = 'POST',
      body,
    }: {
      suffix: string;
      method?: string;
      body: unknown;
    }) =>
      projectsApi(`${base}/${item.id}${suffix}`, {
        method,
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      setComment('');
      await refresh();
    },
    onError,
  });

  const addDocument = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const path = await uploadFile(file, item.directory, true);
        await projectsApi(`${base}/${item.id}/documents`, {
          method: 'POST',
          body: JSON.stringify({ path, comment }),
        });
      }
    },
    onSuccess: async () => {
      setComment('');
      setPendingFiles([]);
      setAddOpen(false);
      await refresh();
    },
    onError,
  });

  const addVersion = useMutation({
    mutationFn: async ({ document, file }: { document: DeliverableDocument; file: File }) => {
      if (file.name !== document.name) throw new Error('filename');
      const separator = document.sourcePath.lastIndexOf('/');
      const directory = separator > 0 ? document.sourcePath.slice(0, separator) : item.directory;
      const path = await uploadFile(file, directory, true);
      await projectsApi(`${base}/${item.id}/documents/${document.id}/versions`, {
        method: 'POST',
        body: JSON.stringify({
          path,
          comment,
          expectedVersion: document.currentVersionNumber,
        }),
      });
    },
    onSuccess: async () => {
      setComment('');
      await refresh();
    },
    onError,
  });

  const busy = disabled || request.isPending || addDocument.isPending || addVersion.isPending;
  const mutationError = request.error || addDocument.error || addVersion.error;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t('deliverableDocuments')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('eachDocumentKeepsItsOwnVersionHistory')}
          </p>
        </div>
        <Button disabled={busy} onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> {t('addDocument')}
        </Button>
      </div>
      {!active.length && (
        <p className="text-sm text-muted-foreground">{t('noDocumentYet')}</p>
      )}
      {!!active.length && (
        <div className="overflow-visible rounded-lg border">
          <div className="hidden grid-cols-[minmax(0,1fr)_7rem_minmax(12rem,0.7fr)_3rem] gap-3 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
            <span>{t('documentName')}</span>
            <span>{t('versions')}</span>
            <span>{t('lastModified')}</span>
            <span className="sr-only">{t('actions')}</span>
          </div>
          {active.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              busy={busy}
              onView={() => setDetail({ document, tab: 'preview' })}
              onHistory={() => setDetail({ document, tab: 'versions' })}
              onDownload={() => void downloadVersion(base, item.id, document, document.versions.at(-1)!, onError)}
              onFile={(file) => addVersion.mutate({ document, file })}
              onSnapshot={() =>
                request.mutate({
                  suffix: `/documents/${document.id}/versions`,
                  body: {
                    path: document.sourcePath,
                    comment,
                    expectedVersion: document.currentVersionNumber,
                  },
                })
              }
              onDelete={() => {
                if (window.confirm(t('deleteDocumentConfirmation', { name: document.name })))
                  request.mutate({
                    suffix: `/documents/${document.id}`,
                    method: 'DELETE',
                    body: { expectedVersion: document.currentVersionNumber },
                  });
              }}
            />
          ))}
        </div>
      )}
      {!!archived.length && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t('deletedDocuments')} ({archived.length})
          </summary>
          <div className="mt-2 space-y-2">
            {archived.map((document) => (
              <div key={document.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <span className="min-w-0 truncate">{document.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => request.mutate({
                    suffix: `/documents/${document.id}/restore`,
                    body: { expectedVersion: document.currentVersionNumber },
                  })}
                >
                  <RotateCcw className="h-4 w-4" /> {t('restore')}
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {mutationError && (
        <p role="alert" className="text-sm text-destructive">
          {mutationError instanceof Error && mutationError.message === 'filename'
            ? t('newVersionMustKeepTheSameFileName')
            : t('unableToUpdateDocument')}
        </p>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('addDocument')}</DialogTitle>
            <DialogDescription>{t('addDocumentDescription')}</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            {t('documents')}
            <Input
              type="file"
              multiple
              disabled={busy}
              onChange={(event) =>
                setPendingFiles(Array.from(event.target.files ?? []))
              }
            />
          </label>
          <label className="grid gap-1 text-sm" htmlFor={`document-comment-${item.id}`}>
            {t('versionComment')}
            <Input
              id={`document-comment-${item.id}`}
              value={comment}
              disabled={busy}
              maxLength={4000}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t('optionalComment')}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setAddOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              disabled={busy || pendingFiles.length === 0}
              onClick={() => addDocument.mutate(pendingFiles)}
            >
              <Upload className="h-4 w-4" /> {t('addDocument')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <DocumentDetailDialog
        detail={detail}
        setDetail={setDetail}
        deliverableId={item.id}
        base={base}
        busy={busy}
        onError={onError}
        onRestore={(document, version) =>
          request.mutate({
            suffix: `/documents/${document.id}/versions/${version.id}/restore`,
            body: {
              expectedVersion: document.currentVersionNumber,
              comment,
            },
          })
        }
      />
    </section>
  );
}

function DocumentDetailDialog({
  detail,
  setDetail,
  deliverableId,
  base,
  busy,
  onError,
  onRestore,
}: {
  detail: { document: DeliverableDocument; tab: 'versions' | 'preview' | 'information' } | null;
  setDetail: (detail: { document: DeliverableDocument; tab: 'versions' | 'preview' | 'information' } | null) => void;
  deliverableId: string;
  base: string;
  busy: boolean;
  onError: () => void;
  onRestore: (document: DeliverableDocument, version: DeliverableDocumentVersion) => void;
}) {
  const { t } = useTranslation();
  const document = detail?.document;
  const latest = document?.versions.at(-1);
  const tabs = [
    { id: 'versions' as const, label: t('versions'), icon: History },
    { id: 'preview' as const, label: t('preview'), icon: Eye },
    { id: 'information' as const, label: t('information'), icon: Info },
  ];

  return (
    <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
      <DialogContent className="flex h-[92dvh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-4 pb-3 pt-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3 pr-8">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate">{document?.name}</DialogTitle>
              <DialogDescription>
                {t('documentDetailSummary', {
                  version: document?.currentVersionNumber ?? 0,
                  author: latest?.authorName ?? '—',
                })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div role="tablist" aria-label={t('documentDetailSections')} className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 sm:px-6">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={detail?.tab === id}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm ${
                detail?.tab === id
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => document && setDetail({ document, tab: id })}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
        {document && detail?.tab === 'versions' && (
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="overflow-hidden rounded-lg border">
              <div className="hidden grid-cols-[5rem_10rem_minmax(0,1fr)_8rem] gap-3 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
                <span>{t('version')}</span>
                <span>{t('date')}</span>
                <span>{t('authorAndComment')}</span>
                <span className="sr-only">{t('actions')}</span>
              </div>
              {document.versions.slice().reverse().map((version) => (
                <article key={version.id} className="grid gap-2 border-t px-3 py-3 first:border-t-0 sm:grid-cols-[5rem_10rem_minmax(0,1fr)_8rem] sm:items-center sm:gap-3">
                  <strong>V{version.number}</strong>
                  <time className="text-sm text-muted-foreground">{new Date(version.createdAt).toLocaleDateString()}</time>
                  <div className="min-w-0 text-sm">
                    <div>{version.authorName}</div>
                    <div className="truncate text-muted-foreground">{version.comment || t('noComment')}</div>
                  </div>
                  <div className="flex justify-end gap-1">
                    <Button size="icon" variant="ghost" aria-label={t('downloadVersion', { version: version.number })} onClick={() => void downloadVersion(base, deliverableId, document, version, onError)}>
                      <Download className="h-4 w-4" />
                    </Button>
                    {version.number !== document.currentVersionNumber && document.deletedAt === null && (
                      <Button size="icon" variant="ghost" aria-label={t('restoreVersion', { version: version.number })} disabled={busy} onClick={() => onRestore(document, version)}>
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{t('restoringCreatesANewVersion')}</p>
          </div>
        )}
        {document && detail?.tab === 'preview' && (
          <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
            <FileViewer filePath={document.sourcePath} viewId={`deliverable:${document.id}`} readOnly />
          </div>
        )}
        {document && detail?.tab === 'information' && (
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
              <DocumentFact label={t('documentName')} value={document.name} />
              <DocumentFact label={t('format')} value={document.format.toUpperCase() || '—'} />
              <DocumentFact label={t('currentVersion')} value={`V${document.currentVersionNumber}`} />
              <DocumentFact label={t('fileSize')} value={latest ? formatBytes(latest.size) : '—'} />
              <DocumentFact label={t('created')} value={new Date(document.createdAt).toLocaleString()} />
              <DocumentFact label={t('lastModified')} value={new Date(document.updatedAt).toLocaleString()} />
              <DocumentFact label={t('author')} value={latest?.authorName ?? '—'} />
              <DocumentFact label={t('checksum')} value={latest?.sha256 ?? '—'} mono />
              <div className="sm:col-span-2">
                <DocumentFact label={t('location')} value={document.sourcePath} mono />
              </div>
            </dl>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words text-sm ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentRow({ document, busy, onView, onHistory, onDownload, onFile, onSnapshot, onDelete }: {
  document: DeliverableDocument;
  busy: boolean;
  onView: () => void;
  onHistory: () => void;
  onDownload: () => void;
  onFile: (file: File) => void;
  onSnapshot: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const latest = document.versions.at(-1);
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: Event) => {
      const menu = menuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const menu = menuRef.current;
      if (menu?.open && event.key === 'Escape') {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    };
    window.document.addEventListener('pointerdown', closeOutside, true);
    window.document.addEventListener('focusin', closeOutside);
    window.document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.document.removeEventListener('pointerdown', closeOutside, true);
      window.document.removeEventListener('focusin', closeOutside);
      window.document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  return (
    <article className="grid gap-2 border-t px-3 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(12rem,0.7fr)_3rem] sm:items-center sm:gap-3">
      <a
        href={withBasePath(`/document?path=${encodeURIComponent(document.sourcePath)}`)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 items-center gap-2 text-left hover:underline"
      >
        <FileText className="h-4 w-4 shrink-0 text-primary" />
        <strong className="truncate">{document.name}</strong>
      </a>
      <span className="text-sm text-muted-foreground">
        <span className="sm:hidden">{t('versions')}: </span>
        {document.currentVersionNumber}
      </span>
      <span className="text-sm text-muted-foreground">
        <span className="sm:hidden">{t('lastModified')}: </span>
        {latest ? `${new Date(latest.createdAt).toLocaleDateString()} · ${latest.authorName}` : '—'}
      </span>
      <details ref={menuRef} className="relative justify-self-end">
        <summary className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted" aria-label={t('actions')}>
          <MoreVertical className="h-4 w-4" />
        </summary>
        <div className="absolute right-0 z-20 mt-1 grid min-w-52 gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted" onClick={onView}><Eye className="h-4 w-4" /> {t('preview')}</button>
          <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted" onClick={onDownload}><Download className="h-4 w-4" /> {t('download')}</button>
          <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted" onClick={onHistory}><History className="h-4 w-4" /> {t('history')}</button>
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
            <Upload className="h-4 w-4" /> {t('uploadNewVersion')}
            <input className="sr-only" type="file" disabled={busy} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
              event.target.value = '';
            }} />
          </label>
          <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted" disabled={busy} onClick={onSnapshot}><History className="h-4 w-4" /> {t('createVersionFromCurrentFile')}</button>
          <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive hover:bg-muted" disabled={busy} onClick={onDelete}><Trash2 className="h-4 w-4" /> {t('delete')}</button>
        </div>
      </details>
    </article>
  );
}

async function uploadFile(file: File, destinationPath: string, overwrite: boolean): Promise<string> {
  const form = new FormData();
  form.append('files', file, file.name);
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/files/upload?destinationPath=${encodeURIComponent(destinationPath)}&overwrite=${overwrite}`), {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
    body: form,
  });
  if (!response.ok) throw new Error('upload');
  const result = (await response.json()) as { files: Array<{ path: string }> };
  if (!result.files[0]?.path) throw new Error('upload');
  return result.files[0].path;
}

async function downloadVersion(base: string, deliverableId: string, document: DeliverableDocument, version: DeliverableDocumentVersion, onError: () => void) {
  try {
    const authorization = getAuthorizationHeader();
    const response = await fetch(withBasePath(`/api/projects${base}/${deliverableId}/documents/${document.id}/versions/${version.id}/file`), {
      headers: authorization ? { Authorization: authorization } : {},
    });
    if (!response.ok) throw new Error('download');
    const url = URL.createObjectURL(await response.blob());
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = version.fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    onError();
  }
}
