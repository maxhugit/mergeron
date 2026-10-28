import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Download,
  Eye,
  FileText,
  History,
  Info,
  MoreVertical,
  MessageSquarePlus,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
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
import {
  beginFileMutation,
  finishFileMutation,
  emitFileChange,
} from '@/lib/file-change-events';
import { showSnackbar } from '@/stores/snackbar-store';
import { WorkspaceEntryMenu } from '@/components/chat/workspace-entry-menu';
import type { FileExtraAction } from '@/components/files/file-context-menu';
import { useDeferredMenuAction } from '@/hooks/use-deferred-menu-action';

type Props = {
  item: Deliverable;
  base: string;
  disabled: boolean;
  refresh: () => Promise<unknown>;
  onError: () => void;
  contextDocument?: DeliverableDocument;
  onAttachToChat?: () => void;
  extraActions?: FileExtraAction[];
  dropdown?: boolean;
  menuLabel?: string;
  children?: ReactNode;
};

function currentDocumentVersion(document?: DeliverableDocument | null) {
  return document?.versions.find(
    (version) => version.number === document.currentVersionNumber,
  );
}

export function DeliverableDocuments({
  item,
  base,
  disabled,
  refresh,
  onError,
  contextDocument,
  onAttachToChat,
  extraActions,
  dropdown,
  menuLabel,
  children,
}: Props) {
  const { t } = useTranslation();
  const { t: documentText } = useTranslation('deliverables');
  const [comment, setComment] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [renaming, setRenaming] = useState<DeliverableDocument | null>(null);
  const [newName, setNewName] = useState('');
  const [detail, setDetail] = useState<{
    document: DeliverableDocument;
    tab: 'versions' | 'preview' | 'information';
  } | null>(null);
  const active = useMemo(
    () =>
      item.documents.filter(
        (document) =>
          document.deletedAt === null &&
          (!contextDocument || document.id === contextDocument.id),
      ),
    [item.documents, contextDocument],
  );
  const archived = useMemo(
    () => item.documents.filter((document) => document.deletedAt !== null),
    [item.documents],
  );

  const request = useMutation({
    onMutate: beginFileMutation,
    onSettled: finishFileMutation,
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
      emitFileChange({
        source: 'local',
        kind: 'invalidate',
        paths: [
          item.directory,
          ...item.documents.map((document) => document.sourcePath),
        ],
      });
      setComment('');
      await refresh();
    },
    onError,
  });

  const addDocument = useMutation({
    onMutate: beginFileMutation,
    onSettled: finishFileMutation,
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await uploadDocument(file, `${base}/${item.id}/documents/upload`, {
          comment,
        });
      }
    },
    onSuccess: async () => {
      emitFileChange({
        source: 'local',
        kind: 'invalidate',
        paths: [item.directory],
      });
      setComment('');
      setPendingFiles([]);
      setAddOpen(false);
      await refresh();
    },
    onError,
  });

  const addVersion = useMutation({
    onMutate: beginFileMutation,
    onSettled: finishFileMutation,
    mutationFn: async ({
      document,
      file,
    }: {
      document: DeliverableDocument;
      file: File;
    }) => {
      if (file.name !== document.name) throw new Error('filename');
      await uploadDocument(file, `${base}/${item.id}/documents/upload`, {
        documentId: document.id,
        expectedVersion: String(document.currentVersionNumber),
        comment,
      });
    },
    onSuccess: async () => {
      emitFileChange({
        source: 'local',
        kind: 'invalidate',
        paths: item.documents.map((document) => document.sourcePath),
      });
      setComment('');
      await refresh();
    },
    onError,
  });

  const rename = useMutation({
    mutationFn: (document: DeliverableDocument) =>
      projectsApi<{
        oldPath: string;
        newPath: string;
        previousFileRetained: boolean;
      }>(`${base}/${item.id}/documents/${document.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: newName,
          expectedName: document.name,
          expectedVersion: document.currentVersionNumber,
        }),
      }),
    onMutate: beginFileMutation,
    onSettled: finishFileMutation,
    onSuccess: async (result) => {
      emitFileChange({
        source: 'local',
        kind: 'rename',
        oldPath: result.oldPath,
        newPath: result.newPath,
      });
      if (result.previousFileRetained)
        showSnackbar(
          documentText('documentRenamePreservedOriginal'),
          'warning',
        );
      setRenaming(null);
      await refresh();
    },
    onError,
  });
  const busy =
    disabled ||
    request.isPending ||
    addDocument.isPending ||
    addVersion.isPending ||
    rename.isPending;
  const mutationError = request.error || addDocument.error || addVersion.error;

  return (
    <section className={contextDocument ? 'contents' : 'space-y-3'}>
      {!contextDocument && (
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
      )}
      {!contextDocument && !active.length && (
        <p className="text-sm text-muted-foreground">{t('noDocumentYet')}</p>
      )}
      {!!active.length && (
        <div
          className={
            contextDocument ? 'contents' : 'overflow-visible rounded-lg border'
          }
        >
          {!contextDocument && (
            <div className="hidden grid-cols-[minmax(0,1fr)_7rem_minmax(12rem,0.7fr)_3rem] gap-3 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
              <span>{t('documentName')}</span>
              <span>{t('versions')}</span>
              <span>{t('lastModified')}</span>
              <span className="sr-only">{t('actions')}</span>
            </div>
          )}
          {active.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              busy={busy}
              contextTrigger={contextDocument ? children : undefined}
              onAttachToChat={contextDocument ? onAttachToChat : undefined}
              extraActions={extraActions}
              dropdown={dropdown}
              menuLabel={menuLabel}
              onView={() => setDetail({ document, tab: 'preview' })}
              onHistory={() => setDetail({ document, tab: 'versions' })}
              onRename={() => {
                rename.reset();
                setNewName(document.name);
                setRenaming(document);
              }}
              onDownload={() => {
                const version = currentDocumentVersion(document);
                if (version)
                  void downloadVersion(
                    base,
                    item.id,
                    document,
                    version,
                    onError,
                    document.name,
                  );
                else onError();
              }}
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
                if (
                  window.confirm(
                    t('deleteDocumentConfirmation', { name: document.name }),
                  )
                )
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
      {!contextDocument && !!archived.length && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t('deletedDocuments')} ({archived.length})
          </summary>
          <div className="mt-2 space-y-2">
            {archived.map((document) => (
              <div
                key={document.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <span className="min-w-0 truncate">{document.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    request.mutate({
                      suffix: `/documents/${document.id}/restore`,
                      body: { expectedVersion: document.currentVersionNumber },
                    })
                  }
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
          {mutationError instanceof Error &&
          mutationError.message === 'filename'
            ? t('newVersionMustKeepTheSameFileName')
            : t('unableToUpdateDocument')}
        </p>
      )}

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open && !rename.isPending) setRenaming(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{documentText('renameDocument')}</DialogTitle>
            <DialogDescription>
              {documentText('renameDocumentDescription')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming && !busy) rename.mutate(renaming);
            }}
          >
            <label className="grid gap-2 text-sm">
              {t('documentName')}
              <Input
                autoFocus
                required
                maxLength={255}
                value={newName}
                disabled={rename.isPending}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            {rename.isError && (
              <p role="alert" className="text-sm text-destructive">
                {documentText('unableToRenameDocument')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={rename.isPending}
                onClick={() => setRenaming(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || !newName.trim() || newName.trim() === renaming?.name
                }
              >
                {t('rename')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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
          <label
            className="grid gap-1 text-sm"
            htmlFor={`document-comment-${item.id}`}
          >
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
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setAddOpen(false)}
            >
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
  detail: {
    document: DeliverableDocument;
    tab: 'versions' | 'preview' | 'information';
  } | null;
  setDetail: (
    detail: {
      document: DeliverableDocument;
      tab: 'versions' | 'preview' | 'information';
    } | null,
  ) => void;
  deliverableId: string;
  base: string;
  busy: boolean;
  onError: () => void;
  onRestore: (
    document: DeliverableDocument,
    version: DeliverableDocumentVersion,
  ) => void;
}) {
  const { t } = useTranslation();
  const document = detail?.document;
  const latest = currentDocumentVersion(document);
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
        <div
          role="tablist"
          aria-label={t('documentDetailSections')}
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 sm:px-6"
        >
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
          <div
            role="tabpanel"
            className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
          >
            <div className="overflow-hidden rounded-lg border">
              <div className="hidden grid-cols-[5rem_10rem_minmax(0,1fr)_8rem] gap-3 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
                <span>{t('version')}</span>
                <span>{t('date')}</span>
                <span>{t('authorAndComment')}</span>
                <span className="sr-only">{t('actions')}</span>
              </div>
              {document.versions
                .slice()
                .reverse()
                .map((version) => (
                  <article
                    key={version.id}
                    className="grid gap-2 border-t px-3 py-3 first:border-t-0 sm:grid-cols-[5rem_10rem_minmax(0,1fr)_8rem] sm:items-center sm:gap-3"
                  >
                    <strong>V{version.number}</strong>
                    <time className="text-sm text-muted-foreground">
                      {new Date(version.createdAt).toLocaleDateString()}
                    </time>
                    <div className="min-w-0 text-sm">
                      <div>{version.authorName}</div>
                      <div className="truncate text-muted-foreground">
                        {version.comment || t('noComment')}
                      </div>
                    </div>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t('downloadVersion', {
                          version: version.number,
                        })}
                        onClick={() =>
                          void downloadVersion(
                            base,
                            deliverableId,
                            document,
                            version,
                            onError,
                          )
                        }
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      {version.number !== document.currentVersionNumber &&
                        document.deletedAt === null && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t('restoreVersion', {
                              version: version.number,
                            })}
                            disabled={busy}
                            onClick={() => onRestore(document, version)}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                    </div>
                  </article>
                ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('restoringCreatesANewVersion')}
            </p>
          </div>
        )}
        {document && detail?.tab === 'preview' && (
          <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
            <FileViewer
              filePath={document.sourcePath}
              viewId={`deliverable:${document.id}`}
              readOnly
            />
          </div>
        )}
        {document && detail?.tab === 'information' && (
          <div
            role="tabpanel"
            className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
          >
            <dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
              <DocumentFact label={t('documentName')} value={document.name} />
              <DocumentFact
                label={t('format')}
                value={document.format.toUpperCase() || '—'}
              />
              <DocumentFact
                label={t('currentVersion')}
                value={`V${document.currentVersionNumber}`}
              />
              <DocumentFact
                label={t('fileSize')}
                value={latest ? formatBytes(latest.size) : '—'}
              />
              <DocumentFact
                label={t('created')}
                value={new Date(document.createdAt).toLocaleString()}
              />
              <DocumentFact
                label={t('lastModified')}
                value={new Date(document.updatedAt).toLocaleString()}
              />
              <DocumentFact
                label={t('author')}
                value={latest?.authorName ?? '—'}
              />
              <DocumentFact
                label={t('checksum')}
                value={latest?.sha256 ?? '—'}
                mono
              />
              <div className="sm:col-span-2">
                <DocumentFact
                  label={t('location')}
                  value={document.sourcePath}
                  mono
                />
              </div>
            </dl>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 break-words text-sm ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentRow({
  document,
  busy,
  onView,
  onHistory,
  onRename,
  onDownload,
  onFile,
  onSnapshot,
  onDelete,
  contextTrigger,
  onAttachToChat,
  extraActions = [],
  dropdown,
  menuLabel,
}: {
  document: DeliverableDocument;
  busy: boolean;
  onView: () => void;
  onHistory: () => void;
  onRename: () => void;
  onDownload: () => void;
  onFile: (file: File) => void;
  onSnapshot: () => void;
  onDelete: () => void;
  contextTrigger?: ReactNode;
  onAttachToChat?: () => void;
  extraActions?: FileExtraAction[];
  dropdown?: boolean;
  menuLabel?: string;
}) {
  const { t } = useTranslation();
  const latest = currentDocumentVersion(document);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const deferred = useDeferredMenuAction();
  useEffect(() => {
    const closeOutside = (event: Event) => {
      const menu = menuRef.current;
      if (
        menu?.open &&
        event.target instanceof Node &&
        !menu.contains(event.target)
      )
        menu.open = false;
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
  const actions = [
    ...(onAttachToChat
      ? [
          {
            label: t('attachToChat'),
            icon: MessageSquarePlus,
            action: 'attach',
          },
        ]
      : []),
    { label: t('preview'), icon: Eye, action: 'view' },
    { label: t('download'), icon: Download, action: 'download' },
    { label: t('history'), icon: History, action: 'history' },
    { label: t('rename'), icon: Pencil, action: 'rename', disabled: busy },
    {
      label: t('uploadNewVersion'),
      icon: Upload,
      action: 'upload',
      disabled: busy,
    },
    {
      label: t('createVersionFromCurrentFile'),
      icon: History,
      action: 'snapshot',
      disabled: busy,
    },
    { label: t('delete'), icon: Trash2, action: 'delete', disabled: busy },
  ];
  const runAction = (action: string) => {
    if (action.startsWith('extra:'))
      return extraActions
        .find((item) => `extra:${item.label}` === action)
        ?.onSelect();
    switch (action) {
      case 'attach':
        return onAttachToChat?.();
      case 'view':
        return onView();
      case 'download':
        return onDownload();
      case 'history':
        return onHistory();
      case 'rename':
        return onRename();
      case 'upload':
        return uploadRef.current?.click();
      case 'snapshot':
        return onSnapshot();
      case 'delete':
        return onDelete();
    }
  };
  const input = (
    <input
      ref={uploadRef}
      aria-label={t('uploadNewVersion')}
      className="sr-only"
      type="file"
      disabled={busy}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onFile(file);
        event.target.value = '';
      }}
    />
  );
  if (contextTrigger)
    if (dropdown)
      return (
        <>
          <WorkspaceEntryMenu
            label={menuLabel ?? document.name}
            onAction={(action) => deferred.select(() => runAction(action))}
            items={[
              ...actions.map(({ label, action, disabled }) => ({
                label,
                disabled,
                destructive: action === 'delete',
                action,
              })),
              ...extraActions.map((action) => ({
                ...action,
                onSelect: () => {
                  deferred.select(action.onSelect);
                },
              })),
            ]}
            onCloseAutoFocus={deferred.afterClose}
          />
          {input}
        </>
      );
  if (contextTrigger)
    return (
      <>
        <ContextMenu>
          <ContextMenuTrigger asChild>{contextTrigger}</ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={deferred.afterClose}>
            {extraActions.map((action) => (
              <ContextMenuItem
                key={action.label}
                disabled={action.disabled}
                onSelect={() => {
                  deferred.select(action.onSelect);
                }}
              >
                {action.label}
              </ContextMenuItem>
            ))}
            {actions.map(({ label, icon: Icon, action, disabled }) => (
              <ContextMenuItem
                key={label}
                variant={action === 'delete' ? 'destructive' : 'default'}
                disabled={disabled}
                onSelect={() => {
                  deferred.select(() => runAction(action));
                }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
        {input}
      </>
    );
  return (
    <article className="grid gap-2 border-t px-3 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(12rem,0.7fr)_3rem] sm:items-center sm:gap-3">
      <a
        href={withBasePath(
          `/document?path=${encodeURIComponent(document.sourcePath)}`,
        )}
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
        {latest
          ? `${new Date(latest.createdAt).toLocaleDateString()} · ${latest.authorName}`
          : '—'}
      </span>
      <details ref={menuRef} className="relative justify-self-end">
        <summary
          className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted"
          aria-label={t('actions')}
        >
          <MoreVertical className="h-4 w-4" />
        </summary>
        <div className="absolute right-0 z-20 mt-1 grid min-w-52 gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          {actions.map(({ label, icon: Icon, action, disabled }) => (
            <button
              key={label}
              type="button"
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted ${action === 'delete' ? 'text-destructive' : ''}`}
              disabled={disabled}
              onClick={() => {
                if (menuRef.current) menuRef.current.open = false;
                runAction(action);
              }}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </details>
      {input}
    </article>
  );
}

async function uploadDocument(
  file: File,
  endpoint: string,
  input: Record<string, string>,
): Promise<void> {
  const form = new FormData();
  form.append('files', file, file.name);
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(`/api/projects${endpoint}?${new URLSearchParams(input)}`),
    {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : {},
      body: form,
    },
  );
  if (!response.ok) throw new Error('upload');
}

async function downloadVersion(
  base: string,
  deliverableId: string,
  document: DeliverableDocument,
  version: DeliverableDocumentVersion,
  onError: () => void,
  fileName = version.fileName,
) {
  try {
    const authorization = getAuthorizationHeader();
    const response = await fetch(
      withBasePath(
        `/api/projects${base}/${deliverableId}/documents/${document.id}/versions/${version.id}/file`,
      ),
      {
        headers: authorization ? { Authorization: authorization } : {},
      },
    );
    if (!response.ok) throw new Error('download');
    const url = URL.createObjectURL(await response.blob());
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    onError();
  }
}
