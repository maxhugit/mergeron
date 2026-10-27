/**
 * File viewer shell — shows file path header and delegates content to the
 * appropriate viewer (Monaco for code/text, ImageViewer for images, etc.).
 */
import { useEffect } from 'react';
import {
  ensureDocumentIdentity,
  pinDocument,
  releaseDocument,
  useDocumentStore,
} from '@/stores/document-store';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { filesGetMetadataOptions } from '@/generated/api/@tanstack/react-query.gen';
import { getFileCategory, isInlineLoadingCategory } from '@/lib/file-category';
import { FileContentViewer } from './viewers';

export function FileViewer({
  filePath,
  documentId,
  viewId,
  active = true,
  readOnly = false,
}: {
  filePath: string;
  documentId?: string;
  viewId: string;
  active?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const selectedFile = filePath;
  readOnly =
    readOnly ||
    /\/\.mergeron-system\//.test(filePath) ||
    /\/(?:\.mergeron|\.webui)\/(?!imported-(?:workspaces|attachments)(?:\/|$))/.test(
      filePath,
    );
  const document = useDocumentStore((state) => {
    const id = documentId ?? state.pathIndex[filePath];
    return id ? state.documents[id] : undefined;
  });
  useEffect(() => {
    const id = documentId ?? ensureDocumentIdentity(filePath);
    const owner = `viewer:${viewId}`;
    pinDocument(id, owner);
    return () => releaseDocument(id, owner);
  }, [documentId, filePath, viewId]);

  // Metadata drives the header and the viewer's loading state only. The write
  // precondition deliberately does not come from here: this query refreshes on
  // its own schedule, independently of the content query, so a modification
  // time taken from it can end up describing a revision the editor never held.
  // `filesReadFile` returns the time paired with the body it read.
  const { isLoading } = useQuery({
    ...filesGetMetadataOptions({ query: { path: selectedFile! } }),
    enabled: !!selectedFile && !document?.detached,
  });

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('selectAFileToView')}
      </div>
    );
  }

  // Inline viewers (media, PDF, image, office previews) own their loading state.
  const loadsInline = isInlineLoadingCategory(getFileCategory(selectedFile));

  if (isLoading && !loadsInline && !document?.model) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loadingb04ba49f')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* File path header */}
      <div className="flex shrink-0 items-center border-b border-border px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground">
          {selectedFile}
          {readOnly && <span className="ml-2"> · {t('readOnly')}</span>}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <FileContentViewer
          filePath={selectedFile}
          documentId={documentId}
          viewId={viewId}
          active={active}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
