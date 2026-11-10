import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MockupFrame } from '@/components/mockups/mockup-frame';
import { useWorkspaceStore } from '@/stores/workspace-store';
import {
  fetchPreviewText,
  previewSourceLabel,
  type PreviewSource,
} from './preview-source';

const CodeViewer = lazy(() =>
  import('./code-viewer').then((m) => ({ default: m.CodeViewer })),
);
const ReadOnlyCodeViewer = lazy(() =>
  import('./read-only-code-viewer').then((m) => ({
    default: m.ReadOnlyCodeViewer,
  })),
);

/** Render the archived HTML itself; never reopen the conversation's newer revision. */
export function HtmlViewer({
  source,
  documentId,
  viewId,
  active,
  readOnly,
}: {
  source: PreviewSource;
  documentId?: string;
  viewId: string;
  active: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation('mockups');
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const reveal = useWorkspaceStore((s) => s.fileViews[viewId]?.reveal);
  // Keep the source open after the editor consumes a line-navigation request.
  if (reveal && mode !== 'source') setMode('source');
  const showSource = mode === 'source' || !!reveal;
  const html = useQuery({
    queryKey: ['preview-text', source],
    queryFn: () => fetchPreviewText(source),
    enabled: active && !showSource,
  });
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('title')}>
      <div className="flex shrink-0 gap-3 border-b p-2 text-sm">
        <button
          type="button"
          aria-pressed={!showSource}
          onClick={() => setMode('preview')}
        >
          {t('preview')}
        </button>
        <button
          type="button"
          aria-pressed={showSource}
          onClick={() => setMode('source')}
        >
          {t('source')}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {showSource ? (
          <Suspense fallback={<p>{t('loading')}</p>}>
            {source.kind === 'file' ? (
              <CodeViewer
                filePath={source.filePath}
                documentId={documentId}
                viewId={viewId}
                active={active}
                readOnly={readOnly}
              />
            ) : (
              <ReadOnlyCodeViewer source={source} />
            )}
          </Suspense>
        ) : html.isError ? (
          <div role="alert" className="p-3 text-sm">
            <p>{t('loadError')}</p>
            <button type="button" onClick={() => void html.refetch()}>
              {t('retry')}
            </button>
          </div>
        ) : html.data !== undefined && active ? (
          <MockupFrame
            key={html.data}
            html={html.data}
            title={previewSourceLabel(source).split('/').pop() ?? t('title')}
          />
        ) : (
          <p role="status" className="p-3 text-sm">
            {t('loading')}
          </p>
        )}
      </div>
    </section>
  );
}
