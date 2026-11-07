import { ExplorerDeliverables } from './explorer-deliverables';
/** Right-hand explorer with a divider preview: dragging never reflows the transcript. */
import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Loader2,
  Folder,
  MapPin,
  Package,
  GitBranch,
  Undo2,
} from 'lucide-react';
import { FileTree } from '@/components/files/file-tree';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  useFileBrowserState as useFilesStore,
  useFileBrowserStoreApi,
  FileBrowserContext,
} from '@/components/files/file-browser-context';
import { createFilesStore } from '@/stores/files-store';
import { useDeliverableDirectoryAliases } from '@/hooks/use-deliverable-directory-aliases';
import { useLayoutStore } from '@/stores/layout-store';
import { filesAddRoot } from '@/generated/api';
import { pathIsWithin } from '@/lib/file-change-events';
import { type ProjectSummary } from '@/lib/projects-api';
import { WorkspaceGitPanel } from './workspace-git-panel';
import { usePlatformSession } from '@/lib/platform-session';
import type {
  GitDiffTarget,
  GitGraphTarget,
  GitRemoteFileTarget,
} from '@/stores/workspace-store';

interface Props {
  ref?: Ref<WorkspaceTreeHandle>;
  agentThreadId?: string;
  cwd: string | null;
  project?: ProjectSummary;
  activeWorkspacePending?: boolean;
  onActiveWorkspaceChange?: (path: string) => void;
  desktop: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
  onFile: (path: string) => void;
  onGitDiff?: (target: GitDiffTarget) => void;
  onGitGraph?: (target: GitGraphTarget) => void;
  onGitRemoteFile?: (target: GitRemoteFileTarget) => void;
}
export interface WorkspaceTreeHandle {
  openDirectory: (path: string) => void;
}

/** Adapts only explorer presentation; the conversation and tab content keep their tree positions. */
export function WorkspaceTree({
  ref,
  agentThreadId,
  cwd,
  project,
  activeWorkspacePending = false,
  onActiveWorkspaceChange,
  desktop,
  mobileOpen,
  onMobileClose,
  onFile,
  onGitDiff,
  onGitGraph,
  onGitRemoteFile,
}: Props) {
  const { t } = useTranslation();
  const hasProject = Boolean(project);
  const browserStore = useFileBrowserStoreApi();
  const { t: tw } = useTranslation('workspaces');
  const session = usePlatformSession();
  const [view, setView] = useState<'folders' | 'deliverables' | 'sources'>(
    'folders',
  );
  const [sourceStore] = useState(createFilesStore);
  const [revealDeliverable, setRevealDeliverable] = useState<string | null>(
    null,
  );
  const aliases = useDeliverableDirectoryAliases(project);
  const [folderConnectionId, setFolderConnectionId] = useState<string | null>(
    null,
  );
  const folderConnections =
    project?.workspaces.filter((w) => !w.sourceResourceId) ?? [];
  const folderConnection =
    folderConnections.find((w) => w.id === folderConnectionId) ??
    folderConnections.find((w) => w.primary);
  const projectRoot =
    project?.workspaces.find((w) => w.primary)?.path ??
    project?.workspacePath ??
    '';
  const atPrimaryReference = Boolean(
    cwd &&
    projectRoot &&
    cwd.replace(/\/+$/, '') === projectRoot.replace(/\/+$/, ''),
  );
  const foldersRoot =
    folderConnection && !folderConnection.primary
      ? folderConnection.path
      : projectRoot.replace(/\/+$/, '') + '/dossiers';
  const revealedDirectory = useRef<{ path: string; cwd: string | null } | null>(
    null,
  );
  const currentRoot = useFilesStore((s) => s.rootDir);
  const [adoptedCwd, setAdoptedCwd] = useState<string | null>(null);
  const [gitResourceId, setGitResourceId] = useState<string | null>(null);
  const collapsed = useLayoutStore((s) => s.workspaceTreeCollapsed);
  const width = useLayoutStore((s) => s.workspaceTreeWidth);
  const setCollapsed = useLayoutStore((s) => s.setWorkspaceTreeCollapsed);
  useImperativeHandle(ref, () => ({
    openDirectory(path) {
      revealedDirectory.current = { path, cwd };

      setGitResourceId(null);
      if (
        project &&
        pathIsWithin(path, projectRoot + '/.mergeron-system/livrables')
      ) {
        setRevealDeliverable(path);
        setView('deliverables');
      } else if (project && !pathIsWithin(path, foldersRoot)) {
        setView('sources');
        sourceStore.getState().setRootDir(path);
      } else {
        setView('folders');
        browserStore.getState().setRootDir(path);
      }
    },
  }));
  // This component shares the conversation's keyed lifetime. Adoption is
  // separate from navigation: browsing may move rootDir anywhere afterwards.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const adopt = () => {
      if (cancelled) return;
      if (adoptedCwd === cwd && browserStore.getState().rootDir) return;
      browserStore
        .getState()
        .setRootDir(
          revealedDirectory.current?.cwd === cwd
            ? revealedDirectory.current.path
            : hasProject
              ? foldersRoot
              : cwd,
        );
      setAdoptedCwd(cwd);
    };
    void filesAddRoot({
      body: { root: cwd },
      throwOnError: true,
      meta: { silent: true },
    }).then(adopt, adopt);
    // Rejection still adopts the requested directory so FileTree can display
    // its read error. A superseded request cannot replace the next root.
    return () => {
      cancelled = true;
    };
  }, [cwd, adoptedCwd, browserStore, project?.id, foldersRoot, hasProject]);
  const contents = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b px-3 text-xs font-medium">
        <span className="flex-1">{project ? project.name : t('explorer')}</span>
        <button
          type="button"
          aria-label={t('closeExplorer')}
          onClick={() => (desktop ? setCollapsed(true) : onMobileClose())}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {project && (
        <>
          <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
            <MapPin className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <span className="block text-muted-foreground">
                {tw('agentReference')}
              </span>
              <span className="block truncate" title={cwd ?? undefined}>
                {(cwd && aliases[cwd]) ||
                  project.workspaces.find((w) => w.path === cwd)?.name ||
                  cwd?.split('/').filter(Boolean).at(-1)}
              </span>
            </div>
            {projectRoot && onActiveWorkspaceChange && !atPrimaryReference && (
              <button
                type="button"
                className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent disabled:opacity-50"
                aria-label={tw('returnToPrimaryReference')}
                title={`${tw('returnToPrimaryReference')} · ${projectRoot}`}
                disabled={activeWorkspacePending}
                aria-busy={activeWorkspacePending}
                onClick={() => onActiveWorkspaceChange(projectRoot)}
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                {tw('primaryReference')}
              </button>
            )}
          </div>
          <div
            className="flex shrink-0 border-b px-2"
            role="tablist"
            aria-label={t('explorer')}
          >
            {(['folders', 'deliverables', 'sources'] as const).map((kind) => {
              const Icon =
                kind === 'folders'
                  ? Folder
                  : kind === 'deliverables'
                    ? Package
                    : GitBranch;
              return (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={view === kind}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1 border-b-2 px-1 py-3 text-xs ${view === kind ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}
                  onClick={() => {
                    setView(kind);
                    if (kind === 'folders')
                      browserStore.getState().setRootDir(foldersRoot);
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tw(
                    kind === 'folders'
                      ? 'explorerFolders'
                      : kind === 'deliverables'
                        ? 'explorerDeliverables'
                        : 'explorerSources',
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
      {/* Never compare the browsed root to cwd: entering folders and going up
          both change it. The adoption receipt prevents showing a prior
          conversation's tree while this one's metadata/request is pending. */}
      {project ? (
        view === 'deliverables' ? (
          <ExplorerDeliverables
            project={project}
            agentThreadId={agentThreadId}
            pending={activeWorkspacePending}
            onReference={onActiveWorkspaceChange}
            onFile={onFile}
            revealPath={revealDeliverable}
          />
        ) : view === 'sources' ? (
          <FileBrowserContext.Provider value={sourceStore}>
            <WorkspaceGitPanel
              onGitRemoteFile={
                onGitRemoteFile
                  ? (target) => {
                      onGitRemoteFile(target);
                      onMobileClose();
                    }
                  : undefined
              }
              agentThreadId={agentThreadId}
              key={project.id}
              projectId={project.id}
              onGitGraph={(target) => {
                onGitGraph?.(target);
                onMobileClose();
              }}
              onGitDiff={(target) => {
                onGitDiff?.(target);
                onMobileClose();
              }}
              resourceId={gitResourceId}
              onSelect={(id) => {
                setGitResourceId(id);
              }}
              cwd={cwd}
              activeWorkspacePending={activeWorkspacePending}
              onActiveWorkspaceChange={onActiveWorkspaceChange}
              onFile={(path) => {
                onFile(path);
                onMobileClose();
              }}
            />
          </FileBrowserContext.Provider>
        ) : (
          <>
            <div className="shrink-0 border-b p-2">
              {folderConnections.length > 1 && (
                <select
                  className="w-full rounded border bg-background p-1 text-xs"
                  aria-label={tw('explorerFolders')}
                  value={folderConnection?.id ?? ''}
                  onChange={(event) => {
                    setFolderConnectionId(event.target.value);
                    const next = folderConnections.find(
                      (w) => w.id === event.target.value,
                    )!;
                    browserStore
                      .getState()
                      .setRootDir(
                        next.primary ? projectRoot + '/dossiers' : next.path,
                      );
                  }}
                >
                  {folderConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.primary
                        ? tw('explorerFolders')
                        : connection.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <FileTree
              agentThreadId={agentThreadId}
              personId={session.data?.personId}
              project={project}
              workspaceRoot={{ path: foldersRoot, name: tw('explorerFolders') }}
              onReferenceDirectory={onActiveWorkspaceChange}
              onFileClick={(path) => {
                onFile(path);
                onMobileClose();
              }}
            />
          </>
        )
      ) : cwd && adoptedCwd === cwd && currentRoot ? (
        <FileTree
          onFileClick={(path) => {
            onFile(path);
            onMobileClose();
          }}
        />
      ) : (
        <div role="status" className="p-4">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
    </div>
  );
  if (!desktop)
    return (
      <Sheet
        open={mobileOpen}
        onOpenChange={(open) => !open && onMobileClose()}
      >
        <SheetContent
          side="right"
          className="!w-[min(85vw,360px)] p-0"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">{t('explorer')}</SheetTitle>
          {contents}
        </SheetContent>
      </Sheet>
    );
  if (collapsed) return null;
  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col border-l bg-background"
      style={{ width, maxWidth: '45%' }}
    >
      <ExplorerDivider />
      {contents}
    </aside>
  );
}

/** Withdrawing the desktop rail disposes its gesture and preview without committing a preference. */
function ExplorerDivider() {
  const { t } = useTranslation();
  const setWidth = useLayoutStore((s) => s.setWorkspaceTreeWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ start: number; width: number } | null>(null);
  /** Preview and commit obey the same CSS max-width constraint. */
  const constrainedWidth = (separator: HTMLElement, proposed: number) => {
    const available =
      separator.parentElement!.parentElement!.getBoundingClientRect().width;
    return Math.min(600, available * 0.45, Math.max(180, proposed));
  };
  return (
    <>
      <div
        role="separator"
        aria-label={t('explorerWidth')}
        aria-orientation="vertical"
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const actual =
              event.currentTarget.parentElement!.getBoundingClientRect().width;
            setWidth(
              constrainedWidth(
                event.currentTarget,
                actual + (event.key === 'ArrowLeft' ? 16 : -16),
              ),
            );
          }
          if (event.key === 'Escape') {
            drag.current = null;
            setPreview(null);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus();
          setPreview(null);
          drag.current = {
            start: event.clientX,
            width:
              event.currentTarget.parentElement!.getBoundingClientRect().width,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setPreview(
              constrainedWidth(
                event.currentTarget,
                drag.current.width + drag.current.start - event.clientX,
              ),
            );
        }}
        onPointerUp={(event) => {
          if (drag.current && event.clientX !== drag.current.start)
            setWidth(
              constrainedWidth(
                event.currentTarget,
                drag.current.width + drag.current.start - event.clientX,
              ),
            );
          drag.current = null;
          setPreview(null);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setPreview(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPreview(null);
        }}
      />
      {preview !== null && (
        <div
          className="pointer-events-none absolute inset-y-0 z-40 w-0.5 bg-primary"
          style={{ right: preview }}
        />
      )}
    </>
  );
}
