/** Archive browser: lists entries and dispatches selected entry to read-only viewers. */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ChevronRight,
  File,
  Folder,
  Loader2,
  Lock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { archiveListArchiveOptions } from '@/generated/api/@tanstack/react-query.gen';
import type { ArchiveEntryDto } from '@/generated/api/types.gen';
import { getFileCategory } from '@/lib/file-category';
import { FileContentViewer } from '.';
import { fetchPreviewText, type PreviewSource } from './preview-source';

interface Props {
  filePath: string;
}

export function ArchiveViewer({ filePath }: Props) {
  const { t } = useTranslation();
  const { t: mockupText } = useTranslation('mockups');
  const [showFiles, setShowFiles] = useState(false);
  const [selected, setSelected] = useState<ArchiveEntryDto | null>(null);

  // Reset selection when archive file changes (adjusting state during render)
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath);
    setShowFiles(false);
    if (selected) setSelected(null);
  }

  const query = useQuery(
    archiveListArchiveOptions({ query: { path: filePath } }),
  );

  const firstFile = useMemo(
    () => findFirstFile(query.data?.entries ?? []),
    [query.data],
  );
  const active = selected ?? firstFile;
  const entrypoint = query.data?.entries.find(
    (entry) =>
      entry.path === 'index.html' &&
      entry.type === 'file' &&
      !entry.encrypted &&
      !entry.unsupported,
  );
  const manifest = query.data?.entries.find(
    (entry) =>
      entry.path === 'mergeron-mockup.json' &&
      entry.type === 'file' &&
      !entry.encrypted &&
      !entry.unsupported &&
      entry.size !== undefined &&
      entry.size <= 16 * 1024,
  );
  const identity = useQuery({
    queryKey: ['mockup-archive-manifest', filePath, query.dataUpdatedAt],
    enabled: !!manifest && !!entrypoint,
    retry: false,
    queryFn: async () => {
      const text = await fetchPreviewText({
        kind: 'archive',
        archivePath: filePath,
        entryPath: 'mergeron-mockup.json',
        label: 'mergeron-mockup.json',
      });
      if (text.length > 16 * 1024) return false;
      const value: unknown = JSON.parse(text);
      return (
        !!value &&
        typeof value === 'object' &&
        'type' in value &&
        value.type === 'mergeron.mockup.archive' &&
        'version' in value &&
        value.version === 1 &&
        'entrypoint' in value &&
        value.entrypoint === 'index.html'
      );
    },
  });

  if (query.isLoading) {
    return (
      <ArchiveMessage
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
        message={t('loadingb04ba49f')}
      />
    );
  }
  if (query.error) return <ArchiveMessage message={t('failedToLoadArchive')} />;
  if (manifest && entrypoint && identity.isLoading)
    return <ArchiveMessage message={t('loadingb04ba49f')} />;
  if (manifest && identity.data && entrypoint && !showFiles)
    return (
      <section className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b p-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setSelected(entrypoint);
              setShowFiles(true);
            }}
          >
            {mockupText('archiveFiles')}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ArchiveEntryPreview archivePath={filePath} entry={entrypoint} />
        </div>
      </section>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {manifest && entrypoint && identity.data && (
        <div className="shrink-0 border-b p-2 text-sm">
          <button type="button" onClick={() => setShowFiles(false)}>
            {mockupText('archivePreview')}
          </button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(8rem,30%)_1fr] sm:grid-cols-[minmax(14rem,20rem)_1fr] sm:grid-rows-1">
        <div className="min-h-0 overflow-auto border-r border-border bg-card/30 p-2">
          {(query.data?.entries ?? []).length === 0 ? (
            <div className="p-2 text-sm text-muted-foreground">
              {t('emptyArchive')}
            </div>
          ) : (
            query.data?.entries.map((entry) => (
              <ArchiveTreeNode
                key={entry.path}
                entry={entry}
                selectedPath={active?.path ?? null}
                onSelect={setSelected}
              />
            ))
          )}
        </div>
        <div className="min-h-0">
          {active ? (
            <ArchiveEntryPreview archivePath={filePath} entry={active} />
          ) : (
            <ArchiveMessage
              icon={<Archive className="h-5 w-5 opacity-50" />}
              message={t('selectAnArchiveEntryToPreview')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ArchiveTreeNode({
  entry,
  selectedPath,
  onSelect,
}: {
  entry: ArchiveEntryDto;
  selectedPath: string | null;
  onSelect: (entry: ArchiveEntryDto) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isDirectory = entry.type === 'directory';
  const isSelected = selectedPath === entry.path;

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/50 ${isSelected ? 'bg-accent text-accent-foreground' : ''}`}
        onClick={() =>
          isDirectory ? setExpanded((value) => !value) : onSelect(entry)
        }
      >
        {isDirectory ? (
          <ChevronRight
            className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        ) : (
          <span className="h-3 w-3" />
        )}
        {isDirectory ? (
          <Folder className="h-3.5 w-3.5" />
        ) : (
          <File className="h-3.5 w-3.5" />
        )}
        <span className="truncate">{entry.name}</span>
        {entry.encrypted && (
          <Lock className="ml-auto h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {isDirectory && expanded && (
        <div className="ml-4">
          {(entry.children ?? []).map((child) => (
            <ArchiveTreeNode
              key={child.path}
              entry={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchiveEntryPreview({
  archivePath,
  entry,
}: {
  archivePath: string;
  entry: ArchiveEntryDto;
}) {
  const { t } = useTranslation();
  const source = useMemo<PreviewSource>(
    () => ({
      kind: 'archive',
      archivePath,
      entryPath: entry.path,
      label: entry.path,
      size: entry.size,
    }),
    [archivePath, entry.path, entry.size],
  );
  const category = getFileCategory(entry.path);

  if (entry.encrypted)
    return <ArchiveMessage message={t('encryptedFilesAreNotSupported')} />;
  if (entry.unsupported)
    return <ArchiveMessage message={t('archiveEntryTypeIsNotSupported')} />;
  if (entry.size !== undefined && entry.size > 50 * 1024 * 1024) {
    return (
      <ArchiveMessage message={t('archiveEntryExceedsThePreviewSizeLimit')} />
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">{entry.path}</span>
        <span className="ml-auto">{category}</span>
      </div>
      <div className="min-h-0 flex-1">
        <FileContentViewer filePath={entry.path} source={source} />
      </div>
    </div>
  );
}

function findFirstFile(entries: ArchiveEntryDto[]): ArchiveEntryDto | null {
  for (const entry of entries) {
    if (entry.type === 'file') return entry;
    const child = findFirstFile(entry.children ?? []);
    if (child) return child;
  }
  return null;
}

function ArchiveMessage({
  icon,
  message,
}: {
  icon?: React.ReactNode;
  message: string;
}) {
  return (
    <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      {icon ?? <Archive className="h-5 w-5 opacity-50" />}
      {message}
    </div>
  );
}
