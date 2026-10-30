import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, File, Folder, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { filesReadTreeOptions } from '@/generated/api/@tanstack/react-query.gen';
import { useFileWatch } from '@/hooks/use-file-watch';
import { Button } from '@/components/ui/button';

/** Browse a linked directory inside its tab, without changing any workspace. */
export function DirectoryViewer({
  directoryPath,
  active,
  renderFile,
  onOpenFile,
}: {
  directoryPath: string;
  active: boolean;
  renderFile: (path: string) => ReactNode;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [history, setHistory] = useState([directoryPath]);
  const [file, setFile] = useState<string | null>(null);
  const directory = history[history.length - 1];
  const listing = useQuery({
    ...filesReadTreeOptions({ query: { root: directory } }),
    enabled: active && file === null,
  });
  useFileWatch(directory, active && file === null);
  return (
    <section
      aria-label={t('folderContents')}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('back')}
          disabled={!file && history.length === 1}
          onClick={() =>
            file ? setFile(null) : setHistory((paths) => paths.slice(0, -1))
          }
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Folder aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 break-all text-xs">{directory}</span>
        {!file && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('refresh')}
            disabled={listing.isFetching}
            onClick={() => void listing.refetch()}
          >
            <RefreshCw className="size-4" />
          </Button>
        )}
      </div>
      {file ? (
        <div className="min-h-0 flex-1">{renderFile(file)}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {listing.isPending ? (
            <p role="status" className="flex items-center gap-2 p-3 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('loadingb04ba49f')}
            </p>
          ) : listing.isError ? (
            <div role="alert" className="space-y-2 p-3 text-sm">
              <p className="break-words">{listing.error.message}</p>
              <Button variant="outline" onClick={() => void listing.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : listing.data.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t('emptyDirectory')}
            </p>
          ) : (
            <ul aria-label={t('files')} className="space-y-1">
              {listing.data.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() =>
                      entry.type === 'directory'
                        ? setHistory((paths) => [...paths, entry.path])
                        : onOpenFile
                          ? onOpenFile(entry.path)
                          : setFile(entry.path)
                    }
                  >
                    {entry.type === 'directory' ? (
                      <Folder aria-hidden="true" className="size-4 shrink-0" />
                    ) : (
                      <File aria-hidden="true" className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 break-all">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
