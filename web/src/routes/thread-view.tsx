/** Conversation workspace: one permanent transcript with sibling file and terminal views. */
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from '@/components/chat/chat-header';
import { ConversationFrame } from '@/components/chat/conversation-frame';
import { WorkspaceControls } from '@/components/chat/workspace-controls';
import { AgentContextLinks } from '@/components/chat/agent-context-links';
import {
  WorkspaceTree,
  type WorkspaceTreeHandle,
} from '@/components/chat/workspace-tree';
import { WorkspaceGitDiff } from '@/components/chat/workspace-git-diff';
import { WorkspaceGitGraph } from '@/components/chat/workspace-git-graph';
import { WorkspaceGitRemoteFile } from '@/components/chat/workspace-git-remote-file';
import { useWorkspaceClose } from '@/components/chat/workspace-close-dialog';
import { FileViewer } from '@/components/files/file-viewer';
import { BrowserModeDialog } from '@/components/chat/browser-mode-dialog';
import { TerminalSurface } from '@/components/terminal/terminal-host';
import { TerminalStatusBar } from '@/components/terminal/terminal-status-bar';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useWorkspaceNavigation } from '@/hooks/use-workspace-navigation';
import {
  OPEN_FILE_EVENT,
  type OpenFileRequestDetail,
} from '@/lib/open-file-request';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import { getApiErrorMessage } from '@/lib/api-error';
import { useTimelineStore } from '@/stores/timeline-store';
import {
  useWorkspaceStore,
  EMPTY_WORKSPACE,
  fileViewId,
} from '@/stores/workspace-store';
import { useLayoutStore } from '@/stores/layout-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useTerminalViewStore } from '@/stores/terminal-view-store';
import { useTerminalDiscovery } from '@/hooks/use-terminal-discovery';
import {
  projectForWorkspace,
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { showSnackbar } from '@/stores/snackbar-store';
import { getAgentFilesStore } from '@/stores/files-store';
import { FileBrowserContext } from '@/components/files/file-browser-context';
import { usePlatformSession } from '@/lib/platform-session';
import { PreviewLinkContext } from '@/lib/preview-link-context';
const BrowserSidebar = lazy(() =>
  import('@/components/chat/browser-sidebar').then((module) => ({
    default: module.BrowserSidebar,
  })),
);
const AgentPreviewPanel = lazy(() =>
  import('@/components/chat/agent-preview-panel').then((m) => ({
    default: m.AgentPreviewPanel,
  })),
);
const LocalBrowserSidebar = lazy(() =>
  import('@/components/chat/local-browser-sidebar').then((module) => ({
    default: module.LocalBrowserSidebar,
  })),
);

/** URL identity owns opening; tab identity controls only presentation and never subscription. */
export function ThreadView() {
  // The authenticated host owns the view's lifetime, not this route outlet.
  return null;
}

/** Keeps every surface at a fixed tree position throughout a conversation's tab switches. */
export function ConversationWorkspace({ threadId }: { threadId: string }) {
  const surfaceActive = useContext(SurfaceActivityContext);
  const [filesStore] = useState(() => getAgentFilesStore(threadId));
  const { t } = useTranslation();
  const { t: tb } = useTranslation('browser');
  const [browserChoice, setBrowserChoice] = useState(false);
  const [localBrowserOpen, setLocalBrowserOpen] = useState(false);
  const [localBrowserEnabled, setLocalBrowserEnabled] = useState(false);
  const [localBrowserStatus, setLocalBrowserStatus] = useState('disconnected');
  const session = usePlatformSession();
  const context = `thread:${threadId}`;
  useTerminalDiscovery(context);
  const workspace = useWorkspaceStore(
    (s) => s.contexts[context] ?? EMPTY_WORKSPACE,
  );
  const openFile = useWorkspaceStore((s) => s.openFile);
  const select = useWorkspaceStore((s) => s.select);
  const showAnnotation = useCallback(() => {
    select(context, 'conversation');
    setLocalBrowserOpen(false);
  }, [context, select]);
  const openLocalBrowser = () => {
    setLocalBrowserEnabled(true);
    setLocalBrowserOpen(true);
  };
  useEffect(() => {
    // Retire legacy local-browser panels, never convert them into container sessions.
    const store = useWorkspaceStore.getState();
    for (const tab of store.contexts[context]?.tabs ?? [])
      if (tab.kind === 'browser' && tab.mode === 'local')
        store.remove(context, tab.id);
  }, [context]);
  const cwd = useTimelineStore((s) =>
    s.threadId === threadId ? s.threadCwd : s.threadsById[threadId]?.threadCwd,
  );
  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const queryClient = useQueryClient();
  const project = projectForWorkspace(
    projectsQuery.data?.projects,
    cwd ?? null,
  );
  const previewProject =
    projectsQuery.data?.projects.find((p) =>
      p.agentThreads?.some((a) => a.threadId === threadId),
    ) ?? project;
  const setActiveWorkspace = useMutation({
    mutationFn: async (nextCwd: string) => {
      const authorization = getAuthorizationHeader();
      const endpoint = project
        ? `/api/projects/${project.id}/agents/${threadId}`
        : `/api/threads/${threadId}/cwd`;
      const response = await fetch(withBasePath(endpoint), {
        method: project ? 'PUT' : 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(
          project
            ? (() => {
                const location = localExecutionSelection(project, nextCwd);
                if (!location)
                  throw new Error(
                    t('executionLocationUnavailable', { ns: 'workspaces' }),
                  );
                return location;
              })()
            : { cwd: nextCwd },
        ),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        threadIds?: string[];
      };
      if (!response.ok) {
        const ownershipErrors: Record<string, string> = {
          GIT_COPY_OWNED: t('gitCopyOwnedElsewhere', { ns: 'workspaces' }),
          GIT_AGENT_COPY_EXISTS: t('gitAgentCopyExists', { ns: 'workspaces' }),
          GIT_COPY_AGENT_REQUIRED: t('gitCopyUnassigned', { ns: 'workspaces' }),
        };
        throw new Error(
          ownershipErrors[payload.message ?? ''] ||
            payload.message ||
            `HTTP ${response.status}`,
        );
      }
      return payload.threadIds?.length ? payload.threadIds : [threadId];
    },
    onSuccess: (threadIds, nextCwd) => {
      const timeline = useTimelineStore.getState();
      for (const id of threadIds) timeline.setThreadCwdForThread(id, nextCwd);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      // The server renews the execution profile for this selection. Do not
      // follow it with a legacy sandbox patch derived from all project copies.
    },
    onError: (error) => showSnackbar(getApiErrorMessage(error), 'error'),
  });
  const running = useTimelineStore(
    (s) =>
      s.threadId === threadId &&
      (s.turnStartPending ||
        Boolean(s.activeTurnId) ||
        s.threadStatus?.type === 'active'),
  );
  const pending = useTimelineStore((s) => {
    if (s.threadId !== threadId) return 0;
    const count =
      Object.values(s.approvals).filter((a) => a.status === 'pending').length +
      Object.values(s.userInputRequests).filter((a) => a.status === 'pending')
        .length;
    const flags =
      s.threadStatus?.type === 'active' ? s.threadStatus.activeFlags : [];
    return Math.max(
      count,
      flags.some(
        (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
      )
        ? 1
        : 0,
    );
  });
  const desktop = useBreakpoint() === 'desktop';
  const [mobileTree, setMobileTree] = useState(false);
  const explorerRef = useRef<WorkspaceTreeHandle>(null);
  const browserDocked = workspace.browserDocked ?? false;
  const lastBrowserId = workspace.lastBrowserId;
  const setBrowserLayout = useWorkspaceStore((state) => state.setBrowserLayout);
  const browserTabs = session.isAdministrator
    ? workspace.tabs
        .filter((tab) => tab.kind === 'browser')
        .filter((tab) => tab.mode !== 'local')
    : [];
  const selectedBrowser = browserTabs.find(
    (tab) => tab.id === workspace.activeId,
  );
  const displayedBrowser =
    selectedBrowser ??
    browserTabs.find((tab) => tab.id === lastBrowserId) ??
    browserTabs.at(-1);
  const browserVisible =
    surfaceActive &&
    Boolean(displayedBrowser) &&
    (Boolean(selectedBrowser) ||
      (desktop && browserDocked && workspace.activeId === 'conversation'));
  const splitBrowser = browserVisible && desktop && browserDocked;
  const conversationVisible =
    surfaceActive &&
    (workspace.activeId === 'conversation' ||
      (splitBrowser && Boolean(selectedBrowser)));
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const { requestClose, dialog } = useWorkspaceClose(context);
  const open = useWorkspaceNavigation(threadId);

  useEffect(() => {
    return () => {
      const current = useWorkspaceStore.getState().contexts[context];
      const tab = current?.tabs.find((entry) => entry.id === current.activeId);
      if (tab?.kind === 'file')
        useWorkspaceStore.getState().cancelReveal(fileViewId(context, tab.id));
    };
  }, [context]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileRequestDetail>).detail;
      if (
        !detail?.path ||
        (detail.sourceThreadId && detail.sourceThreadId !== threadId)
      )
        return;
      openFile(context, detail.path, detail.line);
    };
    window.addEventListener(OPEN_FILE_EVENT, handler);
    return () => window.removeEventListener(OPEN_FILE_EVENT, handler);
  }, [context, threadId, openFile]);

  const newTerminal = async () => {
    if (creatingTerminal) return;
    if (!cwd) return;
    setCreatingTerminal(true);
    const terminal = await useTerminalStore
      .getState()
      .createTerminal(context, cwd ?? undefined);
    setCreatingTerminal(false);
    if (!terminal) return;
    const runtime = useTimelineStore.getState().getThreadRuntime(threadId);
    if (!runtime || runtime.deletedRemotely) {
      useTerminalStore.getState().detachTerminal(terminal.id);
      return;
    }
    useTerminalViewStore.getState().retain(terminal.id, context);
    useWorkspaceStore.getState().openTerminal(context, terminal.id);
  };

  return (
    <FileBrowserContext value={filesStore}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatHeader />
          <WorkspaceControls
            key={desktop ? 'desktop' : 'mobile'}
            workspace={workspace}
            running={running}
            pending={pending}
            onSelect={(id) => {
              if (browserTabs.some((tab) => tab.id === id))
                setBrowserLayout(context, { lastBrowserId: id });
              select(context, id);
            }}
            onClose={requestClose}
            onNewTerminal={() => void newTerminal()}
            canCreateTerminal={session.isAdministrator}
            terminalCreationDisabled={creatingTerminal || !cwd}
            onExplorer={() => {
              if (desktop)
                useLayoutStore
                  .getState()
                  .setWorkspaceTreeCollapsed(
                    !useLayoutStore.getState().workspaceTreeCollapsed,
                  );
              else setMobileTree(true);
            }}
            onBrowser={
              session.isAdministrator ? () => setBrowserChoice(true) : undefined
            }
            onLocalBrowser={
              session.isAdministrator ? openLocalBrowser : undefined
            }
            localBrowserStatus={localBrowserStatus}
            onPreview={
              previewProject
                ? () =>
                    useWorkspaceStore
                      .getState()
                      .openPreview(context, previewProject.id, threadId)
                : undefined
            }
          />
          <AgentContextLinks
            onOpenDirectory={(path) => {
              explorerRef.current?.openDirectory(path);
              if (desktop)
                useLayoutStore.getState().setWorkspaceTreeCollapsed(false);
              else setMobileTree(true);
            }}
            key={threadId}
            threadId={threadId}
            project={
              projectsQuery.data?.projects.find((item) =>
                item.agentThreads?.some((agent) => agent.threadId === threadId),
              ) ?? project
            }
            loading={projectsQuery.isPending}
            failed={projectsQuery.isError}
          />
          <div
            className="relative min-h-0 flex-1"
            aria-label={t('workspaceContent')}
          >
            <div
              role="tabpanel"
              aria-label={t('conversation')}
              className="absolute inset-0"
              inert={!conversationVisible}
              style={{
                visibility: conversationVisible ? 'visible' : 'hidden',
                right: splitBrowser ? '50%' : 0,
              }}
            >
              <PreviewLinkContext.Provider
                value={
                  previewProject
                    ? { projectId: previewProject.id, threadId }
                    : null
                }
              >
                <ConversationFrame
                  threadId={threadId}
                  active={conversationVisible}
                  onRetry={() => open(true)}
                />
              </PreviewLinkContext.Provider>
            </div>
            {browserTabs.map((tab) => (
              <div
                key={tab.id}
                role="tabpanel"
                aria-label={tb('title')}
                className="absolute inset-0 min-h-0 border-l"
                inert={!browserVisible || tab.id !== displayedBrowser?.id}
                style={{
                  visibility:
                    browserVisible && tab.id === displayedBrowser?.id
                      ? 'visible'
                      : 'hidden',
                  left: splitBrowser ? '50%' : 0,
                }}
              >
                <Suspense
                  fallback={
                    <div role="status" className="p-4">
                      …
                    </div>
                  }
                >
                  <BrowserSidebar
                    threadId={threadId}
                    instanceId={tab.id}
                    wasOpened={tab.opened ?? false}
                    onSessionChange={(opened) =>
                      useWorkspaceStore
                        .getState()
                        .setBrowserOpened(context, tab.id, opened)
                    }
                    homeUrl={
                      project?.browserSettings?.homeUrl ??
                      'https://www.google.com'
                    }
                    allowPopups={project?.browserSettings?.allowPopups ?? true}
                    visible={browserVisible && tab.id === displayedBrowser?.id}
                    docked={splitBrowser}
                    onToggleDocked={
                      desktop
                        ? () =>
                            setBrowserLayout(context, {
                              browserDocked: !browserDocked,
                            })
                        : undefined
                    }
                    onClose={() => requestClose(tab)}
                  />
                </Suspense>
              </div>
            ))}
            {workspace.tabs
              .filter((tab) => tab.kind !== 'browser')
              .map((tab) => {
                const active = surfaceActive && workspace.activeId === tab.id;
                return (
                  <SurfaceActivityContext key={tab.id} value={active}>
                    <div
                      role="tabpanel"
                      aria-label={
                        tab.kind === 'file' ||
                        tab.kind === 'git-diff' ||
                        tab.kind === 'git-remote-file'
                          ? tab.path
                          : tab.kind === 'git-graph'
                            ? tab.name
                            : tab.kind === 'preview'
                              ? t('title', { ns: 'previews' })
                              : t('terminal')
                      }
                      className="absolute inset-0 flex min-h-0 flex-col"
                      inert={!active}
                      style={{ visibility: active ? 'visible' : 'hidden' }}
                    >
                      {tab.kind === 'preview' ? (
                        <Suspense fallback={null}>
                          <AgentPreviewPanel
                            projectId={tab.projectId}
                            threadId={tab.threadId}
                            active={active}
                          />
                        </Suspense>
                      ) : tab.kind === 'file' ? (
                        active && (
                          <FileViewer
                            filePath={tab.path}
                            documentId={tab.documentId}
                            onOpenFile={(path) => openFile(context, path)}
                            viewId={fileViewId(context, tab.id)}
                            active={active}
                          />
                        )
                      ) : tab.kind === 'git-remote-file' ? (
                        <WorkspaceGitRemoteFile target={tab} active={active} />
                      ) : tab.kind === 'git-graph' ? (
                        <WorkspaceGitGraph target={tab} active={active} />
                      ) : tab.kind === 'git-diff' ? (
                        <WorkspaceGitDiff
                          target={tab}
                          active={active}
                          onFile={(path) => openFile(context, path)}
                        />
                      ) : (
                        <>
                          <div className="min-h-0 flex-1">
                            <TerminalSurface
                              terminalId={tab.terminalId}
                              contextKey={context}
                              active={active}
                            />
                          </div>
                          <TerminalStatusBar
                            contextKey={context}
                            activeTerminalId={tab.terminalId}
                          />
                        </>
                      )}
                    </div>
                  </SurfaceActivityContext>
                );
              })}
          </div>
        </div>
        <WorkspaceTree
          ref={explorerRef}
          onGitRemoteFile={(target) =>
            useWorkspaceStore.getState().openGitRemoteFile(context, target)
          }
          onGitGraph={(target) =>
            useWorkspaceStore.getState().openGitGraph(context, target)
          }
          agentThreadId={threadId}
          onGitDiff={(target) =>
            useWorkspaceStore.getState().openGitDiff(context, target)
          }
          cwd={cwd ?? null}
          project={project}
          activeWorkspacePending={setActiveWorkspace.isPending}
          onActiveWorkspaceChange={(path) => setActiveWorkspace.mutate(path)}
          desktop={desktop}
          mobileOpen={mobileTree}
          onMobileClose={() => setMobileTree(false)}
          onFile={(path) => openFile(context, path)}
        />
        <BrowserModeDialog
          open={browserChoice}
          onOpenChange={setBrowserChoice}
          isolatedDisabled={browserTabs.length >= 5}
          onChoose={(mode) => {
            if (mode === 'local') openLocalBrowser();
            else {
              useWorkspaceStore.getState().openBrowser(context);
              setBrowserLayout(context, {
                browserDocked: project?.browserSettings?.desktopSplit ?? true,
              });
            }
            setMobileTree(false);
            setBrowserChoice(false);
          }}
        />
        {session.isAdministrator && localBrowserEnabled && (
          <Suspense fallback={null}>
            <LocalBrowserSidebar
              threadId={threadId}
              open={localBrowserOpen}
              onOpenChange={setLocalBrowserOpen}
              onAnnotationAdded={showAnnotation}
              onStatusChange={setLocalBrowserStatus}
            />
          </Suspense>
        )}
        {dialog}
      </div>
    </FileBrowserContext>
  );
}
import { localExecutionSelection } from '@/lib/project-execution-location';
