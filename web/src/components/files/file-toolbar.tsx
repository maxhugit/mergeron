/**
 * File tree toolbar: breadcrumb (up + dir name), refresh all, upload buttons.
 */
import { useRef } from 'react';
import {
  ChevronUp,
  FilePlus,
  FolderPlus,
  FolderUp,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useFileBrowserState as useFilesStore } from './file-browser-context';

interface FileToolbarProps {
  workspaceRoot?: { path: string; name: string };
  directoryAliases?: Record<string, string>;
  /** Called when user selects files or folder to upload into current root. */
  onUpload: (files: FileList, destinationPath: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

export function FileToolbar({
  workspaceRoot,
  directoryAliases,
  onUpload,
  onNewFile,
  onNewFolder,
}: FileToolbarProps) {
  const { t } = useTranslation();
  const rootDir = useFilesStore((s) => s.rootDir);
  const navigateUp = useFilesStore((s) => s.navigateUp);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  if (!rootDir) return null;

  const workspacePath = workspaceRoot?.path.replace(/\/+$/, '') || '/';
  const inWorkspace =
    workspaceRoot?.name &&
    (rootDir === workspacePath ||
      rootDir.startsWith(workspacePath === '/' ? '/' : `${workspacePath}/`));
  const dirName = inWorkspace
    ? [
        workspaceRoot.name,
        ...rootDir
          .slice(workspacePath === '/' ? 1 : workspacePath.length)
          .split('/')
          .filter(Boolean),
      ].join(' › ')
    : (directoryAliases?.[rootDir.replace(/\/+$/, '')] ??
      (rootDir.split('/').pop() || rootDir));

  const refreshAll = () => {
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) => {
        const key = queryKey[0] as { _id?: string } | undefined;
        return key?._id === 'filesReadTree';
      },
    });
  };

  const handleFileUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && rootDir) {
      onUpload(files, rootDir);
    }
    e.target.value = '';
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && rootDir) {
      onUpload(files, rootDir);
    }
    e.target.value = '';
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <button
        type="button"
        onClick={() => navigateUp()}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        title={t('goUp')}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <span className="truncate text-xs text-muted-foreground" title={rootDir}>
        {dirName}
      </span>

      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={onNewFile}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title={t('newFile')}
        >
          <FilePlus className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onNewFolder}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title={t('newFolder')}
        >
          <FolderPlus className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={handleFileUpload}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title={t('uploadFiles')}
        >
          <Upload className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title={t('uploadFolder')}
        >
          <FolderUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={refreshAll}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title={t('refresh')}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is not in React's InputHTMLAttributes
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFolderChange}
      />
    </div>
  );
}
