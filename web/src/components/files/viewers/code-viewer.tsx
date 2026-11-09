/** A disposable editor view over a shared document model and a per-view reading position. */
import { useEffect, useState, useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
  AlertTriangle,
  FilePlus,
  Loader2,
  RotateCcw,
  Save,
  Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  useDocumentStore,
  retainDocument,
  retainDocumentById,
  releaseDocument,
  reloadDocument,
  saveDocument,
} from '@/stores/document-store';
import { useWorkspaceStore, EMPTY_FILE_VIEW } from '@/stores/workspace-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { MarkdownDocument } from './markdown-document';
import { SaveAsDialog } from '@/components/files/save-as-dialog';

interface Props {
  filePath: string;
  documentId?: string;
  viewId: string;
  active: boolean;
  readOnly?: boolean;
}

/** Mounts one editor without owning, resetting, or disposing the document's working text. */
export function CodeViewer({
  filePath,
  documentId: stableDocumentId,
  viewId,
  active,
  readOnly = false,
}: Props) {
  const { t } = useTranslation();
  const document = useDocumentStore((s) => {
    const id = stableDocumentId ?? s.pathIndex[filePath];
    return id ? s.documents[id] : undefined;
  });
  const view = useWorkspaceStore((s) => s.fileViews[viewId] ?? EMPTY_FILE_VIEW);
  const [editor, setEditor] = useState<Parameters<OnMount>[0] | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const documentId = useRef<string | null>(null);
  const markdown = /\.(?:md|markdown|mdown)$/i.test(document?.path ?? filePath);
  const mode =
    readOnly && markdown
      ? 'read'
      : view.reveal
        ? 'edit'
        : (view.markdownMode ?? 'read');
  const showEditor = !markdown || mode !== 'read';
  const showPreview = markdown && mode !== 'edit';

  useEffect(() => {
    documentId.current = stableDocumentId
      ? retainDocumentById(stableDocumentId, viewId)
      : retainDocument(filePath, viewId);
    return () => {
      if (documentId.current) releaseDocument(documentId.current, viewId);
      documentId.current = null;
    };
  }, [filePath, stableDocumentId, viewId]);

  const mount: OnMount = useCallback(
    (instance) => {
      const saved = useWorkspaceStore.getState().fileViews[viewId]?.editor;
      if (saved) instance.restoreViewState(saved);
      setEditor(instance);
    },
    [viewId],
  );

  useEffect(() => {
    if (!editor) return;
    const saveView = () =>
      useWorkspaceStore.getState().saveEditor(viewId, editor.saveViewState());
    const cursor = editor.onDidChangeCursorPosition(saveView);
    const scroll = editor.onDidScrollChange(saveView);
    return () => {
      cursor.dispose();
      scroll.dispose();
    };
  }, [editor, viewId]);

  useEffect(() => {
    if (
      !showEditor ||
      !active ||
      !editor ||
      !document?.model ||
      editor.getModel() !== document.model
    )
      return;
    editor.layout();
    const request = useWorkspaceStore.getState().fileViews[viewId]?.reveal;
    if (!request) return;
    const line = Math.max(
      1,
      Math.min(request.line, document.model.getLineCount()),
    );
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
    useWorkspaceStore.getState().consumeReveal(viewId, request.request);
    if (line !== request.line)
      showSnackbar(
        t('lineLineIsBeyondTheEndOfThisFile', {
          line: request.line,
        }),
        'warning',
      );
  }, [active, showEditor, document?.model, editor, view.reveal, viewId, t]);

  useEffect(() => {
    if (!editor) return;
    const key = editor.onKeyDown((event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.browserEvent.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        if (!readOnly) void saveDocument(documentId.current ?? filePath);
      }
    });
    return () => key.dispose();
  }, [editor, filePath, readOnly]);

  if (!document?.model)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
        {document?.error ? (
          <>
            <AlertTriangle />
            <p>{document.error}</p>
            <Button
              onClick={() => void reloadDocument(stableDocumentId ?? filePath)}
            >
              {t('retry')}
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="animate-spin" />
            {t('loadingb04ba49f')}
          </>
        )}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1 text-xs">
        {markdown && (
          <div
            role="group"
            aria-label={t('markdownViewMode')}
            className="flex items-center gap-1"
          >
            {(['read', 'edit', 'split'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={mode === value ? 'secondary' : 'ghost'}
                aria-pressed={mode === value}
                disabled={readOnly && value !== 'read'}
                onClick={() =>
                  useWorkspaceStore.getState().setMarkdownMode(viewId, value)
                }
              >
                {t(
                  value === 'read'
                    ? 'markdownRead'
                    : value === 'edit'
                      ? 'edit'
                      : 'markdownSplit',
                )}
              </Button>
            ))}
          </div>
        )}
        <span
          className="order-last w-full min-w-0 truncate text-muted-foreground md:order-none md:w-auto md:flex-1"
          role="status"
        >
          {document.error ??
            (document.conflict ? (
              t('fileChangedOnDiskYourUnsavedChangesAreRetained')
            ) : document.dirty ? (
              t('unsavedChanges')
            ) : readOnly ? (
              t('readOnly')
            ) : (
              <span className="inline-flex items-center" title={t('saved')}>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">{t('saved')}</span>
              </span>
            ))}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={t('refresh')}
          disabled={document.detached || document.loading || document.saving}
          onClick={() => void reloadDocument(documentId.current ?? filePath)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={t('saveCtrlS')}
          disabled={
            readOnly ||
            document.detached ||
            document.saving ||
            document.loading ||
            !document.dirty
          }
          onClick={() => void saveDocument(documentId.current ?? filePath)}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
        {document.detached && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            title={t('saveAs')}
            onClick={() => setSaveAsOpen(true)}
          >
            <FilePlus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div
        className={`flex min-h-0 min-w-0 flex-1 ${markdown && mode === 'split' ? 'flex-col md:flex-row' : ''}`}
      >
        <div className={`min-h-0 min-w-0 flex-1 ${showEditor ? '' : 'hidden'}`}>
          <Editor
            path={document.model.uri.toString()}
            keepCurrentModel
            saveViewState={false}
            height="100%"
            theme="vs-dark"
            onMount={mount}
            options={{
              readOnly,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              padding: { top: 8 },
            }}
          />
        </div>
        {showPreview && (
          <div
            className={`min-h-0 min-w-0 flex-1 ${mode === 'split' ? 'border-t md:border-t-0 md:border-l' : ''}`}
          >
            <MarkdownDocument model={document.model} />
          </div>
        )}
      </div>
      {document.detached && (
        <SaveAsDialog
          open={saveAsOpen}
          documentId={document.id}
          onOpenChange={setSaveAsOpen}
        />
      )}
    </div>
  );
}
