/**
 * File content viewer dispatcher — routes to the appropriate viewer by file type.
 * Office files can be delegated to OnlyOffice when configured.
 */
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { settingsListSettings } from '@/generated/api/sdk.gen';
import { getFileCategory } from '@/lib/file-category';
import { useDocumentStore } from '@/stores/document-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { AudioViewer } from './audio-viewer';
import { BinaryViewer } from './binary-viewer';
import { ImageViewer } from './image-viewer';
import { OnlyOfficeViewer } from './onlyoffice-viewer';
import { filePreviewSource, type PreviewSource } from './preview-source';
import { VideoViewer } from './video-viewer';

// Editors and document renderers carry Monaco, PDF.js, SheetJS and document
// parsing code. Loading them only after the matching file type is selected
// keeps those libraries out of every conversation and file-browser visit.
const ArchiveViewer = lazy(() =>
  import('./archive-viewer').then((module) => ({
    default: module.ArchiveViewer,
  })),
);
const CodeViewer = lazy(() =>
  import('./code-viewer').then((module) => ({ default: module.CodeViewer })),
);
const DocxViewer = lazy(() =>
  import('./docx-viewer').then((module) => ({ default: module.DocxViewer })),
);
const FontViewer = lazy(() =>
  import('./font-viewer').then((module) => ({ default: module.FontViewer })),
);
const PdfViewer = lazy(() =>
  import('./pdf-viewer').then((module) => ({ default: module.PdfViewer })),
);
const ReadOnlyCodeViewer = lazy(() =>
  import('./read-only-code-viewer').then((module) => ({
    default: module.ReadOnlyCodeViewer,
  })),
);
const XlsxViewer = lazy(() =>
  import('./xlsx-viewer').then((module) => ({ default: module.XlsxViewer })),
);

interface Props {
  filePath: string;
  documentId?: string;
  source?: PreviewSource;
  viewId?: string;
  active?: boolean;
  readOnly?: boolean;
}

/** Dispatches to the appropriate viewer component based on file extension. */
export function FileContentViewer({
  filePath,
  documentId,
  source,
  viewId = `preview:${filePath}`,
  active = true,
  readOnly = false,
}: Props) {
  const { t } = useTranslation();
  const previewSource = source ?? filePreviewSource(filePath);
  const buffer = useDocumentStore((state) =>
    documentId ? state.documents[documentId] : undefined,
  );
  const category =
    buffer?.model && (buffer.dirty || buffer.detached)
      ? 'code'
      : getFileCategory(filePath);
  const onlyOfficeUrl = useOnlyOfficeUrl();
  const canUseOnlyOffice = previewSource.kind === 'file' && !!onlyOfficeUrl;

  // Line navigation is the text editor's alone. Deciding that here, where the
  // viewer is chosen, keeps a competing file-type table out of the markdown
  // parser — and a line meant for a PDF must not drift into a page number.
  const honoursLine = category === 'code' && previewSource.kind === 'file';
  const reveal = useWorkspaceStore((s) => s.fileViews[viewId]?.reveal);
  const consumeReveal = useWorkspaceStore((s) => s.consumeReveal);
  useEffect(() => {
    if (!reveal || honoursLine || !active) return;
    // Consumed rather than left standing, so it cannot latch onto whichever
    // text file the user opens next.
    consumeReveal(viewId, reveal.request);
    showSnackbar(t('lineNavigationIsNotAvailableForThisFileType'), 'info');
  }, [reveal, honoursLine, consumeReveal, viewId, active, t]);

  let viewer: ReactNode;

  if (
    (category === 'docx' || category === 'xlsx' || category === 'pptx') &&
    canUseOnlyOffice
  ) {
    viewer = <OnlyOfficeViewer filePath={filePath} readOnly={readOnly} />;
  } else {
    switch (category) {
      case 'image':
        viewer = <ImageViewer filePath={filePath} source={previewSource} />;
        break;
      case 'pdf':
        viewer = <PdfViewer source={previewSource} />;
        break;
      case 'video':
        viewer = <VideoViewer source={previewSource} />;
        break;
      case 'audio':
        viewer = <AudioViewer source={previewSource} />;
        break;
      case 'font':
        viewer = <FontViewer source={previewSource} />;
        break;
      case 'archive':
        viewer =
          previewSource.kind === 'file' ? (
            <ArchiveViewer filePath={filePath} />
          ) : (
            <UnsupportedViewer
              message={t('nestedArchivePreviewsAreNotSupported')}
            />
          );
        break;
      case 'docx':
        viewer = <DocxViewer source={previewSource} />;
        break;
      case 'xlsx':
        viewer = <XlsxViewer source={previewSource} />;
        break;
      case 'pptx':
        viewer = (
          <UnsupportedViewer
            message={t('configureOnlyOfficeToPreviewPresentations')}
          />
        );
        break;
      case 'binary':
        viewer = <BinaryViewer source={previewSource} />;
        break;
      case 'code':
      default:
        viewer =
          previewSource.kind === 'file' ? (
            <CodeViewer
              filePath={filePath}
              documentId={documentId}
              viewId={viewId}
              active={active}
              readOnly={readOnly}
            />
          ) : (
            <ReadOnlyCodeViewer source={previewSource} />
          );
    }
  }

  return (
    <Suspense fallback={<ViewerLoadingFallback label={t('loadingb04ba49f')} />}>
      {viewer}
    </Suspense>
  );
}

/** Reads the OnlyOffice URL setting; empty means native viewers remain active. */
function useOnlyOfficeUrl(): string | null {
  const query = useQuery({
    queryKey: ['settings', 'general', 'onlyofficeUrl'],
    queryFn: async () => {
      const { data } = await settingsListSettings({
        query: { category: 'general' },
        throwOnError: true,
      });
      return data.settings;
    },
    staleTime: 30_000,
  });
  const setting = query.data?.find(
    (item) => item.key === 'general.onlyofficeUrl',
  );
  return typeof setting?.value === 'string' && setting.value.trim()
    ? setting.value.trim()
    : null;
}

function UnsupportedViewer({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function ViewerLoadingFallback({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
