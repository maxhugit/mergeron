/** Right-hand explorer with a divider preview: dragging never reflows the transcript. */
import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Folder, Star, LockKeyhole } from 'lucide-react';
import { FileTree } from '@/components/files/file-tree';
import { WorkspaceEntryMenu } from './workspace-entry-menu';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  useFileBrowserState as useFilesStore,
  useFileBrowserStoreApi,
} from '@/components/files/file-browser-context';
import { useLayoutStore } from '@/stores/layout-store';
import { filesAddRoot } from '@/generated/api';
import { pathIsWithin } from '@/lib/file-change-events';
import { type ProjectSummary } from '@/lib/projects-api';
import { WorkspaceGitPanel } from './workspace-git-panel';
import { usePlatformSession } from '@/lib/platform-session';
import { SystemWorkspaceTree } from './system-workspace-tree';
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
  const browserStore = useFileBrowserStoreApi();
  const { t: tw } = useTranslation('workspaces');
  const session = usePlatformSession();
  const [systemOpen, setSystemOpen] = useState(false);
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
      setSystemOpen(false);
      setGitResourceId(null);
      browserStore.getState().setRootDir(path);
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
  }, [cwd, adoptedCwd, browserStore]);
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
        <div className="shrink-0 space-y-1 border-b p-2">
          {session.isAdministrator && project.systemWorkspacePath && (
            <Button
              size="sm"
              variant={systemOpen ? 'secondary' : 'ghost'}
              aria-pressed={systemOpen}
              className="h-7 w-full justify-start text-xs"
              onClick={() => {
                setGitResourceId(null);
                setSystemOpen(true);
              }}
            >
              <LockKeyhole className="h-3.5 w-3.5" />
              {tw('systemWorkspace')}
            </Button>
          )}
          {project.workspaces
            .filter((workspace) => !workspace.sourceResourceId)
            .map((workspace) => {
              const selected = Boolean(
                !gitResourceId &&
                !systemOpen &&
                currentRoot &&
                pathIsWithin(currentRoot, workspace.path),
              );
              const isActive = Boolean(
                cwd &&
                pathIsWithin(cwd, workspace.path) &&
                !project.workspaces.some(
                  (other) =>
                    other.id !== workspace.id &&
                    pathIsWithin(other.path, workspace.path) &&
                    pathIsWithin(cwd, other.path),
                ),
              );
              return (
                <div
                  key={workspace.id}
                  className="flex min-w-0 items-center gap-1"
                >
                  <Button
                    type="button"
                    variant={selected ? 'secondary' : 'ghost'}
                    aria-pressed={selected}
                    size="sm"
                    className="h-7 min-w-0 flex-1 justify-start gap-2 px-2 text-xs"
                    title={workspace.path}
                    onClick={() => {
                      setGitResourceId(null);
                      setSystemOpen(false);
                      browserStore.getState().setRootDir(workspace.path);
                    }}
                  >
                    <Star
                      aria-label={isActive ? t('activeWorkspace') : undefined}
                      className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'fill-primary text-primary' : 'text-muted-foreground'}`}
                    />
                    <Folder className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {workspace.primary
                        ? tw('projectWorkingSpace')
                        : workspace.name}
                    </span>
                  </Button>
                  <WorkspaceEntryMenu
                    label={`${tw('gitWorkspaceMenu')} · ${workspace.name}`}
                    items={[
                      {
                        label: t('useForThisConversation'),
                        disabled:
                          isActive ||
                          activeWorkspacePending ||
                          !onActiveWorkspaceChange,
                        onSelect: () =>
                          onActiveWorkspaceChange?.(workspace.path),
                      },
                      {
                        label: tw('gitBrowseLocal'),
                        onSelect: () => {
                          setGitResourceId(null);
                          setSystemOpen(false);
                          browserStore.getState().setRootDir(workspace.path);
                        },
                      },
                      {
                        label: tw('gitCopyPath'),
                        onSelect: () => {
                          void navigator.clipboard.writeText(workspace.path);
                        },
                      },
                    ]}
                  />
                </div>
              );
            })}
        </div>
      )}
      {/* Never compare the browsed root to cwd: entering folders and going up
          both change it. The adoption receipt prevents showing a prior
          conversation's tree while this one's metadata/request is pending. */}
      {project ? (
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
            setSystemOpen(false);
            setGitResourceId(id);
          }}
          cwd={cwd}
          activeWorkspacePending={activeWorkspacePending}
          onActiveWorkspaceChange={onActiveWorkspaceChange}
          onFile={(path) => {
            onFile(path);
            onMobileClose();
          }}
        >
          {systemOpen &&
          session.isAdministrator &&
          project.systemWorkspacePath ? (
            <SystemWorkspaceTree
              key={project.systemWorkspacePath}
              root={project.systemWorkspacePath}
              onFile={onFile}
            />
          ) : cwd && adoptedCwd === cwd && currentRoot ? (
            <FileTree
              project={project}
              onFileClick={(path) => {
                onFile(path);
                onMobileClose();
              }}
            />
          ) : (
            <div
              role="status"
              className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('loadingb04ba49f')}
            </div>
          )}
        </WorkspaceGitPanel>
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
