/** Conversation workspace: one permanent transcript with sibling file and terminal views. */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from '@/components/chat/chat-header';
import { ConversationFrame } from '@/components/chat/conversation-frame';
import { WorkspaceControls } from '@/components/chat/workspace-controls';
import { AgentContextLinks } from '@/components/chat/agent-context-links';
import { WorkspaceTree } from '@/components/chat/workspace-tree';
import { WorkspaceGitDiff } from '@/components/chat/workspace-git-diff';
import { WorkspaceGitGraph } from '@/components/chat/workspace-git-graph';
import { WorkspaceGitRemoteFile } from '@/components/chat/workspace-git-remote-file';
import { useWorkspaceClose } from '@/components/chat/workspace-close-dialog';
import { FileViewer } from '@/components/files/file-viewer';
import { TerminalSurface } from '@/components/terminal/terminal-host';
import { TerminalStatusBar } from '@/components/terminal/terminal-status-bar';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import {
  applyReadOnlySnapshot,
  HISTORY_PAGE_SIZE,
  useOpenThread,
} from '@/hooks/use-thread-open';
import {
  OPEN_FILE_EVENT,
  type OpenFileRequestDetail,
} from '@/lib/open-file-request';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import { currentThreadEpoch } from '@/lib/thread-recovery-epoch';
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
import { threadsListTurns, threadsReadThread } from '@/generated/api/sdk.gen';
import {
  projectForWorkspace,
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { showSnackbar } from '@/stores/snackbar-store';
import { useThreadSecurityPolicy } from '@/hooks/use-thread-security-policy';
import { invalidateThreadListSoon } from '@/lib/query-invalidation';
import { usePlatformSession } from '@/lib/platform-session';
const BrowserSidebar = lazy(() =>
  import('@/components/chat/browser-sidebar').then((module) => ({
    default: module.BrowserSidebar,
  })),
);

/** URL identity owns opening; tab identity controls only presentation and never subscription. */
export function ThreadView() {
  const params: unknown = useParams({ strict: false });
  const threadId =
    params &&
    typeof params === 'object' &&
    'threadId' in params &&
    typeof params.threadId === 'string'
      ? params.threadId
      : '';
  return <ConversationWorkspace key={threadId} threadId={threadId} />;
}

/** Keeps every surface at a fixed tree position throughout a conversation's tab switches. */
function ConversationWorkspace({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const { t: tb } = useTranslation('browser');
  const session = usePlatformSession();
  const context = `thread:${threadId}`;
  useTerminalDiscovery(context);
  const workspace = useWorkspaceStore(
    (s) => s.contexts[context] ?? EMPTY_WORKSPACE,
  );
  const openFile = useWorkspaceStore((s) => s.openFile);
  const select = useWorkspaceStore((s) => s.select);
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
  const policy = useThreadSecurityPolicy(threadId);
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
      const sandbox = policy.observed?.sandboxPolicy;
      if (sandbox?.type === 'workspaceWrite' && project) {
        policy.apply({
          sandboxPolicy: {
            ...sandbox,
            writableRoots: project.workspaces
              .filter((workspace) => !workspace.readOnly)
              .map((workspace) => workspace.path)
              .filter((workspacePath) => workspacePath !== nextCwd),
          },
        });
      }
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
  const [browserDocked, setBrowserDocked] = useState(false);
  const hasBrowser =
    session.isAdministrator &&
    workspace.tabs.some((tab) => tab.kind === 'browser');
  const browserVisible =
    hasBrowser &&
    (workspace.activeId === 'browser' ||
      (desktop && browserDocked && workspace.activeId === 'conversation'));
  const splitBrowser = browserVisible && desktop && browserDocked;
  const conversationVisible =
    workspace.activeId === 'conversation' ||
    (splitBrowser && workspace.activeId === 'browser');
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const { requestClose, dialog } = useWorkspaceClose(context);
  const { mutate: openThread } = useOpenThread();

  const open = useCallback(() => {
    const resume = () =>
      openThread(
        { path: { threadId } },
        {
          onError: () => {
            if (
              useTimelineStore.getState().getThreadRuntime(threadId)?.hydrated
            )
              return;
            const epoch = currentThreadEpoch(threadId);
            // Archived/read-only fallback uses the same full-page display contract.
            void Promise.all([
              threadsReadThread({ path: { threadId }, throwOnError: true }),
              threadsListTurns({
                path: { threadId },
                query: {
                  limit: HISTORY_PAGE_SIZE,
                  sortDirection: 'desc',
                  itemsView: 'full',
                },
                throwOnError: true,
              }),
            ])
              .then(([metadata, page]) => {
                if (
                  epoch === currentThreadEpoch(threadId) &&
                  useTimelineStore.getState().threadId === threadId
                )
                  return applyReadOnlySnapshot(metadata.data, page.data);
              })
              .catch((error: unknown) => {
                if (epoch !== currentThreadEpoch(threadId)) return;
                useTimelineStore.getState().setOpenStateForThread(threadId, {
                  openState: 'error',
                  historyRequest: 'error',
                  historyError: getApiErrorMessage(error),
                });
              });
          },
        },
      );
    void projectsApi<{
      removed: string[];
      reassignedAgents: number;
      reassignedSimpleChats: number;
      unresolved: string[];
    }>('/reconcile-workspaces', { method: 'POST' })
      .then(async (result) => {
        if (result.removed.length) {
          await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
          invalidateThreadListSoon(queryClient);
          showSnackbar(
            t('countMissingWorkspaceReferenceSCleanedUp', {
              count: result.removed.length,
            }),
            'info',
          );
        }
        if (result.unresolved.length)
          showSnackbar(t('aProjectHasNoRemainingWorkspaceOnDisk'), 'warning');
      })
      .catch((error) => showSnackbar(getApiErrorMessage(error), 'warning'))
      .finally(resume);
  }, [openThread, queryClient, t, threadId]);

  useEffect(() => {
    open();
    return () => {
      useTimelineStore.getState().unsubscribeThread(threadId);
      const current = useWorkspaceStore.getState().contexts[context];
      const tab = current?.tabs.find((entry) => entry.id === current.activeId);
      if (tab?.kind === 'file')
        useWorkspaceStore.getState().cancelReveal(fileViewId(context, tab.id));
    };
  }, [threadId, context, open]);

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
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader />
        <WorkspaceControls
          key={desktop ? 'desktop' : 'mobile'}
          workspace={workspace}
          running={running}
          pending={pending}
          onSelect={(id) => select(context, id)}
          onClose={requestClose}
          onNewTerminal={() => void newTerminal()}
          canCreateTerminal={session.isAdministrator}
          terminalCreationDisabled={creatingTerminal || !cwd}
          onExplorer={() => {
            setBrowserDocked(false);
            if (workspace.activeId === 'browser')
              select(context, 'conversation');
            if (desktop)
              useLayoutStore
                .getState()
                .setWorkspaceTreeCollapsed(
                  !useLayoutStore.getState().workspaceTreeCollapsed,
                );
            else setMobileTree(true);
          }}
          onBrowser={
            session.isAdministrator
              ? () => {
                  useWorkspaceStore.getState().openBrowser(context);
                  setMobileTree(false);
                  useLayoutStore.getState().setWorkspaceTreeCollapsed(true);
                }
              : undefined
          }
        />
        <AgentContextLinks
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
            <ConversationFrame
              threadId={threadId}
              active={conversationVisible}
              onRetry={open}
            />
          </div>
          {hasBrowser && (
            <div
              role="tabpanel"
              aria-label={tb('title')}
              className="absolute inset-0 min-h-0 border-l"
              inert={!browserVisible}
              style={{
                visibility: browserVisible ? 'visible' : 'hidden',
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
                  key={threadId}
                  threadId={threadId}
                  visible={browserVisible}
                  docked={splitBrowser}
                  onToggleDocked={
                    desktop
                      ? () => setBrowserDocked((value) => !value)
                      : undefined
                  }
                  onClose={() =>
                    useWorkspaceStore.getState().remove(context, 'browser')
                  }
                />
              </Suspense>
            </div>
          )}
          {workspace.tabs
            .filter((tab) => tab.kind !== 'browser')
            .map((tab) => {
              const active = workspace.activeId === tab.id;
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
                          : t('terminal')
                    }
                    className="absolute inset-0 flex min-h-0 flex-col"
                    inert={!active}
                    style={{ visibility: active ? 'visible' : 'hidden' }}
                  >
                    {tab.kind === 'file' ? (
                      active && (
                        <FileViewer
                          filePath={tab.path}
                          documentId={tab.documentId}
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
      {dialog}
    </div>
  );
}
import { localExecutionSelection } from '@/lib/project-execution-location';
