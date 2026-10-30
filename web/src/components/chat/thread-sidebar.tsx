/**
 * Left sidebar: global actions (top) + workspace-grouped thread navigation.
 * Rendering is split into sidebar/ sub-components; this file orchestrates
 * state, queries, mutations, and view routing.
 */
import { useCallback, useMemo, useState } from 'react';
import { DragDropProvider } from '@dnd-kit/react';
import { BookOpen, FolderKanban, FolderOpen, House, Plus } from 'lucide-react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  threadsArchiveThreadMutation,
  threadsCompactThreadMutation,
  threadsForkThreadMutation,
  threadsListOverviewOptions,
  threadsSetThreadNameMutation,
  threadsUnarchiveThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import type { ThreadDto } from '@/generated/api';
import { createProjectAgent } from '@/lib/project-agent-creation';
import { selectSidebarRows } from '@/lib/sidebar-rows';
import { useTimelineStore } from '@/stores/timeline-store';
import { useLayoutStore } from '@/stores/layout-store';
import { cn } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api-error';
import {
  invalidateBranchTreeMembersSoon,
  invalidateBranchTreesSoon,
  invalidateThreadListSoon,
} from '@/lib/query-invalidation';
import { BranchGraphDialog } from '@/components/branches/branch-graph-dialog';
import { DeleteConversationDialog } from '@/components/branches/delete-conversation-dialog';
import {
  adoptionBlockReason,
  buildDeleteRequestBody,
  useBranchAdoptionStatus,
  useDeletePreview,
  useDeleteThread,
} from '@/hooks/use-thread-deletion';
import type { ConfirmAction, WorkspaceGroup } from './sidebar/sidebar-types';
import { threadLabel } from './sidebar/sidebar-types';
import { ThreadRow } from './sidebar/thread-row';
import { WorkspaceOverview } from './sidebar/workspace-overview';
import { WorkspaceDetail } from './sidebar/workspace-detail';
import { ArchivedAgentsDetail } from './sidebar/archived-agents-detail';
import { SimpleChatRow } from './sidebar/simple-chat-row';
import { RenameDialog, ConfirmDialog } from './sidebar/sidebar-dialogs';
import { ForkGoalDialog } from './sidebar/fork-goal-dialog';
import { CreateProjectDialog } from './sidebar/create-project-dialog';
import { ProjectArchiveExportDialog } from '@/components/projects/project-archive-transfer';
import { usePlatformSession } from '@/lib/platform-session';
import { useForkWithGoal } from '@/hooks/use-fork-with-goal';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import type { SimpleChatThreadSummary } from '@/lib/simple-chat-api';
import { simpleChatThreadsQueryKey } from '@/lib/simple-chat-api';
import { useSimpleChatActivityStore } from '@/stores/simple-chat-activity-store';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectResourceSummary,
  type ProjectSummary,
} from '@/lib/projects-api';

type SimpleChatThread = SimpleChatThreadSummary;

function simpleChatHeaders(hasBody = false) {
  const authorization = getAuthorizationHeader();
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

async function simpleChatApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(`/api/simple-chat${path}`), {
    ...init,
    headers: {
      ...simpleChatHeaders(init?.body !== undefined),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    message?: string;
  };
  if (!response.ok)
    throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}

/** Derives the active "view" from the current route path. */
function useActiveView():
  | 'chat'
  | 'home'
  | 'help'
  | 'simpleChat'
  | 'files'
  | 'terminal'
  | 'diagnostics'
  | 'settings'
  | 'integrations'
  | 'other' {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname.startsWith('/files')) return 'files';
  if (pathname.startsWith('/terminal')) return 'terminal';
  if (pathname.startsWith('/diagnostics')) return 'diagnostics';
  if (pathname.startsWith('/integrations')) return 'integrations';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/simple-chat')) return 'simpleChat';
  if (pathname === '/') return 'home';
  if (pathname === '/help') return 'help';
  if (pathname.startsWith('/t/')) return 'chat';
  return 'other';
}

export function ThreadSidebar() {
  const session = usePlatformSession();
  const [exportProjectId, setExportProjectId] = useState<string | null>(null);
  const navigate = useNavigate();
  const activeView = useActiveView();
  const activeSimpleThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread,
  });
  const activeResourceId = useRouterState({
    select: (state) =>
      state.location.pathname.match(
        /\/projects\/[^/]+\/resources\/([^/]+)/,
      )?.[1],
  });
  const activeProjectId = useRouterState({
    select: (state) =>
      state.location.pathname.match(/\/projects\/([^/]+)/)?.[1],
  });
  const { t } = useTranslation(['common', 'projectArchives']);
  const threadId = useTimelineStore((s) => s.threadId);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const turnStartPending = useTimelineStore((s) => s.turnStartPending);
  const activeTurnId = useTimelineStore((s) => s.activeTurnId);
  const approvals = useTimelineStore((s) => s.approvals);
  const threadStatus = useTimelineStore((s) => s.threadStatus);
  const threadsById = useTimelineStore((s) => s.threadsById);
  const subscribedThreadIds = useTimelineStore((s) => s.subscribedThreadIds);
  const setActiveThread = useTimelineStore((s) => s.setActiveThread);
  const clearThread = useTimelineStore((s) => s.clearThread);
  const setThreadTitle = useTimelineStore((s) => s.setThreadTitle);
  const addSystemError = useTimelineStore((s) => s.addSystemError);
  const queryClient = useQueryClient();
  const activeSimpleChatIds = useSimpleChatActivityStore(
    (state) => state.activeThreadIds,
  );

  // ── Layout store (sidebar view + collapsed groups) ──────────────────
  const sidebarView = useLayoutStore((s) => s.sidebarView);
  const setSidebarView = useLayoutStore((s) => s.setSidebarView);
  const collapsedGroupKeys = useLayoutStore((s) => s.collapsedGroupKeys);
  const toggleCollapsedGroup = useLayoutStore((s) => s.toggleCollapsedGroup);
  // Derive Set<string> for child components that expect it
  const collapsedGroups = useMemo(
    () => new Set(collapsedGroupKeys),
    [collapsedGroupKeys],
  );

  // ── Local UI state (ephemeral) ─────────────────────────────────────
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [renameThread, setRenameThread] = useState<ThreadDto | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [graphTargetId, setGraphTargetId] = useState<string | null>(null);
  const [renameSimpleThread, setRenameSimpleThread] =
    useState<SimpleChatThread | null>(null);
  const [renameSimpleValue, setRenameSimpleValue] = useState('');
  const [deleteSimpleThread, setDeleteSimpleThread] =
    useState<SimpleChatThread | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectValue, setCreateProjectValue] = useState('');
  const [deleteProject, setDeleteProject] = useState<ProjectSummary | null>(
    null,
  );
  const [deleteProjectError, setDeleteProjectError] = useState('');
  const [renameResource, setRenameResource] =
    useState<ProjectResourceSummary | null>(null);
  const [renameResourceValue, setRenameResourceValue] = useState('');
  const [deleteResource, setDeleteResource] =
    useState<ProjectResourceSummary | null>(null);
  const [pendingConversation, setPendingConversation] = useState<{
    kind: 'agent' | 'simple';
    group: WorkspaceGroup;
  } | null>(null);
  const [deleteProjectWorkspaceIds, setDeleteProjectWorkspaceIds] = useState<
    Set<string>
  >(new Set());

  // ── Queries ─────────────────────────────────────────────────────────
  // The sidebar reads one server-side projection. It used to join a paginated
  // thread list with the branch topology on the client, fold branches into
  // their root row and lift the newest member's timestamp for sorting — a
  // derivation over two independently refetched queries. Whichever landed
  // first was rendered, so a single delete visibly reshuffled the list twice.
  // Debouncing could not fix that: it coalesces repeats of one query, not the
  // gap between two.
  //
  // The two home-view queries are gated on the home view actually being shown.
  // Overview and detail replace one another in the tree below, but these ran
  // unconditionally, so sitting in a workspace kept refetching two projections
  // nothing was rendering. The backend now serves warm requests from a shared
  // metadata collection, so this no longer enumerates the stored list per
  // request — but each projection still collapses whole branch trees, and a
  // refetch nothing renders is still work spent on a view that is not on screen.
  //
  // Gating is safe for painting — TanStack Query keeps the last data for a
  // disabled query, so returning to the home view paints immediately and
  // refetches in the background. That retained data must not be read as though
  // it were current: see `displayedRows` below.
  const isHomeView = sidebarView.type === 'overview';
  // Activity updates must not move agents or change which ones occupy the
  // project preview. Manual project sidebarOrder still takes precedence.
  const overviewThreadsQuery = useQuery({
    ...threadsListOverviewOptions({
      query: { archived: false, limit: 100, sortKey: 'created_at' },
    }),
    enabled: isHomeView,
  });
  const detailQuery = useQuery({
    ...threadsListOverviewOptions({
      query: {
        archived: false,
        cwd:
          sidebarView.type === 'workspaceDetail' ? sidebarView.cwd : undefined,
        cursor: cursor ?? undefined,
        limit: 20,
        sortKey: 'created_at',
      },
    }),
    enabled: sidebarView.type === 'workspaceDetail',
  });
  const simpleChatThreadsQuery = useQuery({
    queryKey: simpleChatThreadsQueryKey,
    queryFn: () => simpleChatApi<{ threads: SimpleChatThread[] }>('/threads'),
  });
  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });

  // ── Deletion ────────────────────────────────────────────────────────
  const adoptionStatus = useBranchAdoptionStatus();
  const deleteBlockedReason = adoptionBlockReason(adoptionStatus.data, t);
  const deletePreview = useDeletePreview(deleteTargetId);
  // No survivor to offer: this entry point deletes a whole conversation tree,
  // so there is nothing left of it to land on.
  const deleteThread = useDeleteThread({
    onFinished: () => {
      setDeleteTargetId(null);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });

  // Rows arrive already collapsed and sorted; the client only indexes them so
  // a row can be looked up by the thread it displays.
  const rowsByView = useMemo(
    () => ({
      active: overviewThreadsQuery.data?.data ?? [],
      archived: [],
      detail: detailQuery.data?.data ?? [],
    }),
    [overviewThreadsQuery.data, detailQuery.data],
  );
  // Which views may contribute, and why, is enforced in `selectSidebarRows`.
  const { rowByThreadId, displayThreadIdByMember, visibleThreads } = useMemo(
    () => selectSidebarRows(rowsByView, isHomeView),
    [rowsByView, isHomeView],
  );

  const activeThreads = useMemo(
    () => rowsByView.active.map((row) => row.thread),
    [rowsByView.active],
  );
  const linkedTaskByThreadId = useMemo(() => {
    const links = new Map<
      string,
      {
        projectId: string;
        resourceId: string;
        taskId: string;
        title: string;
        isSubtask: boolean;
      }
    >();
    for (const project of projectsQuery.data?.projects ?? [])
      for (const agent of project.agentThreads ?? [])
        if (agent.taskId && agent.taskResourceId)
          links.set(agent.threadId, {
            projectId: project.id,
            resourceId: agent.taskResourceId,
            taskId: agent.taskId,
            title: agent.taskTitle ?? agent.title,
            isSubtask: agent.isSubtask,
          });
    return links;
  }, [projectsQuery.data]);
  const workspaceGroups = useMemo(() => {
    const groups: WorkspaceGroup[] = (projectsQuery.data?.projects ?? []).map(
      (project) => ({
        projectId: project.id,
        name: project.name,
        cwd: project.workspacePath,
        workspaces: project.workspaces,
        resources: project.resources,
        sidebarOrder: project.sidebarOrder,
        archivedAgents: (project.agentThreads ?? []).filter(
          (agent) => agent.archived,
        ),
        threads: [] as ThreadDto[],
        simpleChats: [] as SimpleChatThread[],
      }),
    );
    const groupsByProject = new Map(
      groups.map((group) => [group.projectId, group]),
    );
    const legacyGroupByCwd = new Map<string, WorkspaceGroup>();
    for (const group of groups)
      for (const workspace of group.workspaces ?? [])
        legacyGroupByCwd.set(workspace.path, group);
    const agentProjects = new Map<string, string>();
    for (const project of projectsQuery.data?.projects ?? [])
      for (const agent of project.agentThreads ?? [])
        agentProjects.set(agent.threadId, project.id);
    for (const thread of activeThreads) {
      const group =
        groupsByProject.get(agentProjects.get(thread.id) ?? '') ??
        legacyGroupByCwd.get(thread.cwd);
      if (group) group.threads.push(thread);
    }
    for (const simpleChat of simpleChatThreadsQuery.data?.threads ?? []) {
      const group = groupsByProject.get(simpleChat.projectId ?? '');
      if (group) group.simpleChats.push(simpleChat);
    }
    return groups;
  }, [activeThreads, simpleChatThreadsQuery.data, projectsQuery.data]);
  const detailProject =
    sidebarView.type === 'workspaceDetail'
      ? projectsQuery.data?.projects.find(
          (project) => project.workspacePath === sidebarView.cwd,
        )
      : undefined;
  const archivedProject =
    sidebarView.type === 'archivedDetail'
      ? projectsQuery.data?.projects.find(
          (project) => project.id === sidebarView.projectId,
        )
      : undefined;
  const detailThreads =
    sidebarView.type !== 'workspaceDetail'
      ? []
      : detailProject
        ? Array.from(
            new Map(
              [...rowsByView.detail.map((row) => row.thread), ...activeThreads]
                .filter((thread) =>
                  detailProject.agentThreads?.some(
                    (agent) => agent.threadId === thread.id,
                  ),
                )
                .map((thread) => [thread.id, thread]),
            ).values(),
          )
        : rowsByView.detail.map((row) => row.thread);

  const highlightedThreadId = threadId
    ? (displayThreadIdByMember.get(threadId) ?? threadId)
    : null;

  // Shares the timer the socket dispatcher uses, so a mutation and the
  // notification it provokes produce one refetch rather than two.
  const invalidateThreads = () => invalidateThreadListSoon(queryClient);

  // ── Thread open helpers ─────────────────────────────────────────────
  //
  // The sidebar navigates and nothing more. Opening — resume, hydration, the
  // loading decision — belongs to the route, which is the only place that can
  // know a conversation is already on screen. Doing it here as well meant one
  // click resumed the same thread twice, and resume is not a read: it claims
  // writer ownership.

  /**
   * True when the thread is already open *and on screen*.
   *
   * Selecting a thread leaves it selected in the store while the user moves to
   * settings, diagnostics or integrations, so store state alone cannot answer
   * "is a click a no-op" — the chat view has to actually be the one showing.
   */
  const isThreadOnScreen = (
    threadIdToCheck: string,
    mode: 'live' | 'readOnly',
  ) =>
    threadIdToCheck === threadId &&
    threadMode === mode &&
    activeView === 'chat';

  /**
   * Resolves which member of a collapsed row to actually open.
   *
   * A row stands for a whole branch tree, so opening it at the tree root would
   * discard the branch the user was last reading and force them to step back
   * through the version switcher one at a time. The server resolves the pointer
   * — it is shared across devices — and falls back to the displayed thread.
   */
  const openTargetFor = (thread: ThreadDto): string =>
    rowByThreadId.get(thread.id)?.openThreadId ?? thread.id;

  /** Navigate to archived thread — ThreadView handles loading (resume → fail → read). */
  const openArchivedThread = (thread: ThreadDto) => {
    const target = openTargetFor(thread);
    if (isThreadOnScreen(target, 'readOnly')) return;
    void navigate({ to: '/t/$threadId', params: { threadId: target } });
  };

  const openLiveThread = (thread: ThreadDto) => {
    const target = openTargetFor(thread);
    if (isThreadOnScreen(target, 'live')) return;
    void navigate({ to: '/t/$threadId', params: { threadId: target } });
  };

  /**
   * Leaves an archived conversation, accounting for whole-tree archival.
   *
   * Archiving a root archives its hidden branches too, so the check cannot be
   * "am I on the row that was archived" — the user may be sitting on a branch
   * that has no row of its own.
   */
  const switchAfterArchive = (
    archivedId: string,
    memberThreadIds: readonly string[],
  ) => {
    const current = useTimelineStore.getState();
    const archivedTree = new Set(memberThreadIds);
    if (
      !current.threadId ||
      !archivedTree.has(current.threadId) ||
      current.threadMode !== 'live'
    ) {
      return;
    }
    const idx = visibleThreads.findIndex((th) => th.id === archivedId);
    const next =
      visibleThreads.slice(idx + 1).find((th) => !archivedTree.has(th.id)) ??
      visibleThreads.slice(0, idx).find((th) => !archivedTree.has(th.id));
    if (next) openLiveThread(next);
    else {
      clearThread();
      void navigate({ to: '/' });
    }
  };

  // ── Mutations ───────────────────────────────────────────────────────
  const createThread = useMutation({
    mutationFn: createProjectAgent,
    onSuccess: (res) => {
      void setActiveThread(
        res.thread.id,
        res.cwd,
        threadLabel(res.thread, t('newWorkAgent')),
      );
      invalidateThreads();
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      void navigate({
        to: '/t/$threadId',
        params: { threadId: res.thread.id },
      });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  const reorderSidebar = useMutation({
    mutationFn: ({
      projectId,
      order,
    }: {
      projectId: string;
      order: string[];
    }) =>
      projectsApi(`/${projectId}/sidebar-order`, {
        method: 'PATCH',
        body: JSON.stringify({ order }),
      }),
    onMutate: async ({ projectId, order }) => {
      await queryClient.cancelQueries({ queryKey: projectsQueryKey });
      const previous = queryClient.getQueryData<{ projects: ProjectSummary[] }>(
        projectsQueryKey,
      );
      queryClient.setQueryData<{ projects: ProjectSummary[] }>(
        projectsQueryKey,
        (current) =>
          current
            ? {
                projects: current.projects.map((project) =>
                  project.id === projectId
                    ? { ...project, sidebarOrder: order }
                    : project,
                ),
              }
            : current,
      );
      return { previous };
    },
    onError: (err, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(projectsQueryKey, context.previous);
      addSystemError(getApiErrorMessage(err));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: projectsQueryKey }),
  });

  const handleThreadDragEnd = useCallback(
    (event: {
      canceled: boolean;
      operation: {
        source: { id?: string | number; data?: Record<string, unknown> } | null;
        target: { id?: string | number; data?: Record<string, unknown> } | null;
      };
    }) => {
      if (event.canceled || reorderSidebar.isPending) return;
      const source = event.operation.source?.data;
      const target = event.operation.target?.data;
      if (target?.kind !== 'workspace' && target?.kind !== 'sidebar-item')
        return;
      const sourceProjectId = source?.projectId as string | undefined;
      const targetProjectId = target?.projectId as string | undefined;
      if (!sourceProjectId || sourceProjectId !== targetProjectId) return;
      const sourceItemId = source?.sidebarItemId as string | undefined;
      const targetItemId = target?.sidebarItemId as string | undefined;
      if (!sourceItemId || sourceItemId === targetItemId) return;
      const project = projectsQuery.data?.projects.find(
        (candidate) => candidate.id === sourceProjectId,
      );
      if (!project) return;
      const validItems = [
        ...project.resources.map((resource) => `resource:${resource.id}`),
        ...(project.agentThreads ?? [])
          .filter((thread) => !thread.archived)
          .map((thread) => `agent:${thread.threadId}`),
        ...(simpleChatThreadsQuery.data?.threads ?? [])
          .filter((thread) => thread.projectId === project.id)
          .map((thread) => `simple:${thread.id}`),
      ];
      if (!validItems.includes(sourceItemId)) return;
      const valid = new Set(validItems);
      const order = [
        ...(project.sidebarOrder ?? []).filter((item) => valid.has(item)),
        ...validItems.filter(
          (item) => !(project.sidebarOrder ?? []).includes(item),
        ),
      ];
      const sourceIndex = order.indexOf(sourceItemId);
      order.splice(sourceIndex, 1);
      const targetIndex = targetItemId ? order.indexOf(targetItemId) : -1;
      order.splice(
        targetIndex >= 0 ? targetIndex : order.length,
        0,
        sourceItemId,
      );
      reorderSidebar.mutate({ projectId: project.id, order });
    },
    [projectsQuery.data, reorderSidebar, simpleChatThreadsQuery.data?.threads],
  );

  const archiveThread = useMutation({
    ...threadsArchiveThreadMutation(),
    // Carry the confirmation's membership into this mutation's context. A
    // refetch can remove the row while the dialog or the HTTP request is open.
    onMutate: (vars) => {
      const pending =
        confirmAction?.type === 'archive'
          ? confirmAction.memberThreadIds
          : null;
      const treeIds = [...(pending ?? [vars.path.threadId])];
      setConfirmAction(null);
      return { treeIds };
    },
    onSuccess: (_res, vars, context) => {
      const treeIds = context.treeIds;
      for (const id of treeIds)
        useTimelineStore.getState().unsubscribeThread(id);
      switchAfterArchive(vars.path.threadId, treeIds);
    },
    // Whole-tree archival can fail partway through, leaving some members
    // archived; the list is stale either way, so refresh on settled.
    onSettled: () => {
      invalidateThreads();
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  const unarchiveThread = useMutation({
    ...threadsUnarchiveThreadMutation(),
    onSuccess: (res) => {
      if (threadId === res.thread.id && threadMode === 'readOnly')
        openLiveThread(res.thread);
    },
    onSettled: () => {
      invalidateThreads();
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  const compactThread = useMutation({
    ...threadsCompactThreadMutation(),
    onSuccess: () => invalidateThreads(),
  });

  const forkThread = useMutation({
    ...threadsForkThreadMutation(),
    onSuccess: (res, vars) => {
      const tid = res.thread.id;
      invalidateThreads();
      invalidateBranchTreesSoon(queryClient);
      invalidateBranchTreeMembersSoon(queryClient, [vars.path.threadId, tid]);
      // The fork response is metadata-only. Navigation hands hydration to the
      // canonical opener, which pages history and reads inherited auxiliary
      // data only after the backend has committed the provenance edge.
      void navigate({ to: '/t/$threadId', params: { threadId: tid } });
    },
  });

  // Forking asks about the source goal first, and only when one is live.
  const fork = useForkWithGoal({
    onFork: (threadId, carryGoal) =>
      forkThread.mutate({ path: { threadId }, body: { carryGoal } }),
  });

  const updateThreadName = useMutation({
    ...threadsSetThreadNameMutation(),
    onSuccess: (_res, vars) => {
      if (vars.path.threadId === threadId)
        setThreadTitle(vars.body.name.trim());
      setRenameThread(null);
      setRenameValue('');
      invalidateThreads();
    },
  });
  const createSimpleChatThread = useMutation({
    mutationFn: ({ projectId }: { projectId: string }) =>
      simpleChatApi<{ thread: SimpleChatThread }>('/threads', {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: simpleChatThreadsQueryKey,
      });
      void navigate({
        to: '/simple-chat',
        search: { thread: result.thread.id },
      });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const renameSimpleChat = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      simpleChatApi(`/threads/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      setRenameSimpleThread(null);
      setRenameSimpleValue('');
      void queryClient.invalidateQueries({
        queryKey: simpleChatThreadsQueryKey,
      });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const deleteSimpleChat = useMutation({
    mutationFn: (id: string) =>
      simpleChatApi(`/threads/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, deletedId) => {
      setDeleteSimpleThread(null);
      void queryClient.invalidateQueries({
        queryKey: simpleChatThreadsQueryKey,
      });
      if (activeView === 'simpleChat' && activeSimpleThreadId === deletedId) {
        void navigate({ to: '/' });
      }
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const createProject = useMutation({
    mutationFn: ({ name }: { name: string }) =>
      projectsApi<{ project: ProjectSummary }>('', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setCreateProjectOpen(false);
      setCreateProjectValue('');
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const deleteProjectMutation = useMutation({
    mutationFn: (project: ProjectSummary) =>
      projectsApi(`/${project.id}`, {
        method: 'DELETE',
        body: JSON.stringify({
          confirmation: project.name,
          deleteWorkspaceIds: [...deleteProjectWorkspaceIds],
        }),
      }),
    onMutate: () => setDeleteProjectError(''),
    onSuccess: () => {
      setDeleteProject(null);
      setDeleteProjectError('');
      setDeleteProjectWorkspaceIds(new Set());
      void queryClient.invalidateQueries();
      void navigate({ to: '/' });
    },
    onError: (err) => {
      const message = getApiErrorMessage(err);
      setDeleteProjectError(message);
      addSystemError(message);
    },
  });
  const createTaskBoard = useMutation({
    mutationFn: (projectId: string) =>
      projectsApi<{ resource: ProjectSummary['resources'][number] }>(
        `/${projectId}/resources`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'task_board' }),
        },
      ),
    onSuccess: ({ resource }) => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      void navigate({
        to: '/projects/$projectId/resources/$resourceId',
        params: { projectId: resource.projectId, resourceId: resource.id },
        search: { task: undefined },
      });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const createOptionalBoard = useMutation({
    mutationFn: ({
      projectId,
      type,
    }: {
      projectId: string;
      type: 'automation_board' | 'deliverable_board';
    }) =>
      projectsApi<{ resource: ProjectSummary['resources'][number] }>(
        `/${projectId}/resources`,
        {
          method: 'POST',
          body: JSON.stringify({ type }),
        },
      ),
    onSuccess: ({ resource }) => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      void navigate({
        to: '/projects/$projectId/resources/$resourceId',
        params: { projectId: resource.projectId, resourceId: resource.id },
        search: { task: undefined },
      });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const renameProjectResource = useMutation({
    mutationFn: ({
      resource,
      name,
    }: {
      resource: ProjectResourceSummary;
      name: string;
    }) =>
      projectsApi<{ resource: ProjectResourceSummary }>(
        `/${resource.projectId}/resources/${resource.id}`,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      ),
    onSuccess: () => {
      setRenameResource(null);
      setRenameResourceValue('');
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['project-resource'] });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const deleteProjectResource = useMutation({
    mutationFn: (resource: ProjectResourceSummary) =>
      projectsApi(`/${resource.projectId}/resources/${resource.id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_result, resource) => {
      setDeleteResource(null);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      if (activeResourceId === resource.id) void navigate({ to: '/' });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  // ── View navigation helpers ─────────────────────────────────────────

  const resetDetailPagination = () => {
    setCursor(null);
    setCursorStack([]);
  };

  const openWorkspaceDetail = (cwd: string) => {
    resetDetailPagination();
    setSidebarView({ type: 'workspaceDetail', cwd });
  };
  const openArchivedDetail = (projectId: string) => {
    resetDetailPagination();
    setSidebarView({ type: 'archivedDetail', projectId });
  };

  const goNext = () => {
    if (!detailQuery.data?.nextCursor) return;
    setCursorStack((s) => [...s, cursor]);
    setCursor(detailQuery.data.nextCursor);
  };
  const goPrevious = () => {
    setCursorStack((s) => {
      const ns = s.slice(0, -1);
      setCursor(s.at(-1) ?? null);
      return ns;
    });
  };

  // ── Rename / Confirm ────────────────────────────────────────────────
  const startRename = (thread: ThreadDto) => {
    setRenameThread(thread);
    setRenameValue(threadLabel(thread));
  };
  const saveRename = () => {
    if (!renameThread) return;
    const name = renameValue.trim();
    if (!name) return;
    updateThreadName.mutate({
      path: { threadId: renameThread.id },
      body: { name },
    });
  };
  const confirmCurrentAction = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'archive') {
      archiveThread.mutate({ path: { threadId: confirmAction.thread.id } });
      // onMutate transfers the pending action before dismissing its dialog.
      return;
    }
    if (confirmAction.type === 'compact')
      compactThread.mutate({ path: { threadId: confirmAction.thread.id } });
    setConfirmAction(null);
  };

  // ── Shared thread-row renderer (passed to overview/detail) ──────────
  const renderThreadRow = (
    thread: ThreadDto,
    archived: boolean,
    rowProjectId?: string,
  ) => {
    const row = rowByThreadId.get(thread.id);
    const linkedTask = linkedTaskByThreadId.get(thread.id);
    const readRuntime = (id: string) =>
      id === threadId
        ? { turnStartPending, activeTurnId, approvals, threadStatus }
        : threadsById[id];

    // Row flags come from the server, which already lifted them off hidden
    // branch members. Local socket state is layered on top because it is
    // instantaneous where the projection is only as fresh as its last refetch.
    // This is safe in a way the old client-side join was not: these flags feed
    // badges, never ordering, so a difference between the two sources cannot
    // reshuffle the list.
    const treeRuntimes = (row?.memberThreadIds ?? [thread.id])
      .map(readRuntime)
      .filter((runtime) => runtime !== undefined);

    // Cached lifecycle stops advancing when the transcript leaves its room.
    // It cannot override the backend's current status for a background member.
    const observedRuntimes = (row?.memberThreadIds ?? [thread.id])
      .filter((id) => subscribedThreadIds.has(id))
      .map(readRuntime)
      .filter((runtime) => runtime !== undefined);
    const isRunning = observedRuntimes.some(
      (runtime) => runtime.turnStartPending || runtime.activeTurnId,
    );
    const activeFlags = observedRuntimes.flatMap((runtime) =>
      runtime.threadStatus?.type === 'active'
        ? runtime.threadStatus.activeFlags
        : [],
    );
    const localPendingCount = treeRuntimes.reduce(
      (total, runtime) =>
        total +
        Object.values(runtime.approvals ?? {}).filter(
          (a) => a.status === 'pending',
        ).length,
      0,
    );
    const pendingApprovalCount = Math.max(
      localPendingCount,
      row?.pendingApprovalCount ?? 0,
    );
    const waitingOnApproval =
      Boolean(row?.waitingOnApproval) ||
      activeFlags.includes('waitingOnApproval') ||
      pendingApprovalCount > 0;
    const waitingOnUserInput =
      Boolean(row?.waitingOnUserInput) ||
      activeFlags.includes('waitingOnUserInput');
    // "Generating" = thread active but not blocked on any user-facing request.
    const generating =
      (Boolean(row?.running) ||
        observedRuntimes.some(
          (runtime) => runtime.threadStatus?.type === 'active',
        )) &&
      !waitingOnApproval &&
      !waitingOnUserInput;

    return (
      <ThreadRow
        key={thread.id}
        thread={thread}
        archived={archived}
        isActive={thread.id === highlightedThreadId && activeView === 'chat'}
        destructiveDisabled={isRunning || Boolean(row?.running)}
        actionPending={forkThread.isPending || unarchiveThread.isPending}
        running={generating || isRunning}
        pendingApproval={waitingOnApproval}
        pendingApprovalCount={pendingApprovalCount}
        waitingOnUserInput={waitingOnUserInput}
        hasBranchDescendants={Boolean(row?.hasBranchDescendants)}
        onOpen={() => {
          if (archived) void openArchivedThread(thread);
          else openLiveThread(thread);
        }}
        onRename={() => startRename(thread)}
        onArchive={() =>
          setConfirmAction({
            type: 'archive',
            thread,
            memberThreadIds: [...(row?.memberThreadIds ?? [thread.id])],
          })
        }
        onUnarchive={() =>
          unarchiveThread.mutate({ path: { threadId: thread.id } })
        }
        onCompact={() => setConfirmAction({ type: 'compact', thread })}
        onFork={() => void fork.requestFork(thread.id)}
        deleteBlockedReason={deleteBlockedReason}
        onDelete={() => setDeleteTargetId(thread.id)}
        onShowBranchGraph={() => setGraphTargetId(thread.id)}
        linkedTask={linkedTask}
        onOpenLinkedTask={
          linkedTask
            ? () =>
                void navigate({
                  to: '/projects/$projectId/resources/$resourceId',
                  params: {
                    projectId: linkedTask.projectId,
                    resourceId: linkedTask.resourceId,
                  },
                  search: { task: linkedTask.taskId },
                })
            : undefined
        }
        draggable={!archived && !!rowProjectId}
        projectId={rowProjectId}
      />
    );
  };

  const renderSimpleChatRow = (thread: SimpleChatThread) => (
    <SimpleChatRow
      key={thread.id}
      thread={thread}
      isActive={
        activeView === 'simpleChat' && activeSimpleThreadId === thread.id
      }
      disabled={reorderSidebar.isPending}
      running={activeSimpleChatIds.has(thread.id)}
      onOpen={() =>
        void navigate({ to: '/simple-chat', search: { thread: thread.id } })
      }
      onRename={() => {
        setRenameSimpleThread(thread);
        setRenameSimpleValue(thread.title);
      }}
      onDelete={() => setDeleteSimpleThread(thread)}
    />
  );

  const createConversationIn = (
    kind: 'agent' | 'simple',
    cwd: string,
    projectId: string,
  ) => {
    setPendingConversation(null);
    if (kind === 'agent') {
      createThread.mutate({ projectId, workspacePath: cwd });
    } else createSimpleChatThread.mutate({ projectId });
  };

  const requestConversation = (
    kind: 'agent' | 'simple',
    group: WorkspaceGroup,
  ) => {
    const workspaces = group.workspaces ?? [];
    if (kind === 'simple') {
      if (group.projectId)
        createSimpleChatThread.mutate({ projectId: group.projectId });
      return;
    }
    if (workspaces.length <= 1) {
      if (!group.projectId) return;
      createConversationIn(
        kind,
        workspaces[0]?.path ?? group.cwd,
        group.projectId,
      );
      return;
    }
    setPendingConversation({ kind, group });
  };

  const projectsHeader = (
    <div className="flex shrink-0 items-center justify-between px-1 py-2">
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground/90">
        <FolderKanban aria-hidden="true" className="h-4 w-4 shrink-0" />
        {t('projects')}
      </span>
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={t('newProject')}
          title={t('newProject')}
          onClick={() => setCreateProjectOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col bg-card/80">
      {/* Global actions */}
      <div className="shrink-0 space-y-0.5 px-2 py-2">
        <button
          type="button"
          onClick={() => void navigate({ to: '/help' })}
          aria-current={activeView === 'help' ? 'page' : undefined}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'help'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('platformGuide')}
        </button>
        <button
          type="button"
          onClick={() => void navigate({ to: '/' })}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'home'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <House className="h-4 w-4 shrink-0" />
          {t('home')}
        </button>
      </div>

      <Separator />

      <ScrollArea className="min-h-0 flex-1 px-2 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <DragDropProvider onDragEnd={handleThreadDragEnd}>
          {sidebarView.type !== 'overview' && projectsHeader}
          {sidebarView.type === 'overview' ? (
            <WorkspaceOverview
              projectsHeader={projectsHeader}
              workspaceGroups={workspaceGroups}
              collapsedGroups={collapsedGroups}
              isLoading={
                overviewThreadsQuery.isLoading || projectsQuery.isLoading
              }
              onToggleCollapse={toggleCollapsedGroup}
              onOpenProject={(projectId) =>
                void navigate({
                  to: '/projects/$projectId',
                  params: { projectId },
                })
              }
              onOpenArchivedDetail={openArchivedDetail}
              onOpenWorkspaceDetail={openWorkspaceDetail}
              onCreateAgentInWorkspace={(group) =>
                requestConversation('agent', group)
              }
              onCreateSimpleChatInWorkspace={(group) =>
                requestConversation('simple', group)
              }
              onCreateTaskBoard={(group) =>
                group.projectId && createTaskBoard.mutate(group.projectId)
              }
              onCreateAutomationBoard={(group) =>
                group.projectId &&
                createOptionalBoard.mutate({
                  projectId: group.projectId,
                  type: 'automation_board',
                })
              }
              onCreateDeliverables={(group) =>
                group.projectId &&
                createOptionalBoard.mutate({
                  projectId: group.projectId,
                  type: 'deliverable_board',
                })
              }
              onOpenResource={(projectId, resourceId) =>
                void navigate({
                  to: '/projects/$projectId/resources/$resourceId',
                  params: { projectId, resourceId },
                  search: { task: undefined },
                })
              }
              activeResourceId={activeResourceId}
              activeProjectId={activeProjectId}
              resourceActionPending={
                renameProjectResource.isPending ||
                reorderSidebar.isPending ||
                deleteProjectResource.isPending
              }
              onRenameResource={(resource) => {
                setRenameResource(resource);
                setRenameResourceValue(resource.name);
              }}
              onDeleteResource={setDeleteResource}
              onExportProject={
                session.isAdministrator
                  ? (group) => {
                      if (group.projectId) setExportProjectId(group.projectId);
                    }
                  : undefined
              }
              onDeleteProject={(group) => {
                if (!group.projectId) return;
                setDeleteProjectError('');
                setDeleteProjectWorkspaceIds(new Set());
                setDeleteProject({
                  id: group.projectId,
                  name: group.name ?? group.cwd,
                  workspacePath: group.cwd,
                  createdAt: 0,
                  updatedAt: 0,
                  workspaces: group.workspaces ?? [],
                  resources: group.resources ?? [],
                });
              }}
              renderThreadRow={renderThreadRow}
              renderSimpleChatRow={renderSimpleChatRow}
              movingThread={reorderSidebar.isPending}
            />
          ) : sidebarView.type === 'archivedDetail' && archivedProject ? (
            <ArchivedAgentsDetail
              project={archivedProject}
              pending={unarchiveThread.isPending || deleteThread.isPending}
              onBack={() => setSidebarView({ type: 'overview' })}
              onOpen={(agent) =>
                void navigate({
                  to: '/t/$threadId',
                  params: { threadId: agent.threadId },
                })
              }
              onRestore={(agent) =>
                unarchiveThread.mutate({
                  path: { threadId: agent.threadId },
                })
              }
              onDelete={(agent) => setDeleteTargetId(agent.threadId)}
            />
          ) : sidebarView.type === 'workspaceDetail' ? (
            <WorkspaceDetail
              sidebarView={sidebarView}
              threads={detailThreads}
              simpleChats={
                cursorStack.length === 0
                  ? (simpleChatThreadsQuery.data?.threads.filter((thread) =>
                      detailProject
                        ? thread.projectId === detailProject.id
                        : false,
                    ) ?? [])
                  : []
              }
              projectName={detailProject?.name}
              isLoading={detailQuery.isLoading}
              hasPrevious={cursorStack.length > 0}
              hasNext={!!detailQuery.data?.nextCursor}
              onBack={() => setSidebarView({ type: 'overview' })}
              onPrevious={goPrevious}
              onNext={goNext}
              renderThreadRow={renderThreadRow}
              renderSimpleChatRow={renderSimpleChatRow}
            />
          ) : (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground">
              {t('noArchivedThreads')}
            </div>
          )}
        </DragDropProvider>
      </ScrollArea>

      {/* The collapse toggle deliberately lives in the shell header, not here:
          a control pinned to the sidebar's own bottom edge disappears with the
          sidebar, which forced expanding to live somewhere else entirely. */}

      {exportProjectId && (
        <ProjectArchiveExportDialog
          projectId={exportProjectId}
          open
          onOpenChange={(open) => {
            if (!open) setExportProjectId(null);
          }}
        />
      )}
      <CreateProjectDialog
        open={createProjectOpen}
        pending={createProject.isPending}
        name={createProjectValue}
        onNameChange={setCreateProjectValue}
        onSave={() => {
          if (createProjectValue.trim())
            createProject.mutate({
              name: createProjectValue.trim(),
            });
        }}
        onClose={() => {
          setCreateProjectOpen(false);
          setCreateProjectValue('');
        }}
      />
      <AlertDialog
        open={pendingConversation !== null}
        onOpenChange={(open) => !open && setPendingConversation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chooseAWorkspace')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chooseTheFileAndExecutionContextForThisConversation')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            {(pendingConversation?.group.workspaces ?? []).map((workspace) => (
              <Button
                key={workspace.id}
                variant={workspace.primary ? 'secondary' : 'outline'}
                className="justify-start"
                onClick={() =>
                  pendingConversation &&
                  pendingConversation.group.projectId &&
                  createConversationIn(
                    pendingConversation.kind,
                    workspace.path,
                    pendingConversation.group.projectId,
                  )
                }
              >
                <FolderOpen className="h-4 w-4" />
                {workspace.primary ? t('primaryWorkspace') : workspace.name}
              </Button>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenameDialog
        open={renameResource !== null}
        pending={renameProjectResource.isPending}
        value={renameResourceValue}
        onChange={setRenameResourceValue}
        onSave={() => {
          if (renameResource && renameResourceValue.trim())
            renameProjectResource.mutate({
              resource: renameResource,
              name: renameResourceValue.trim(),
            });
        }}
        onClose={() => setRenameResource(null)}
        title={t('renameTaskManager')}
      />
      <AlertDialog
        open={deleteResource !== null}
        onOpenChange={(open) =>
          !open && !deleteProjectResource.isPending && setDeleteResource(null)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteThisTaskManager')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('thisTaskBoardAndAllOfItsFutureTasksWillBePermanentlyDeleted')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProjectResource.isPending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!deleteResource || deleteProjectResource.isPending}
              onClick={() =>
                deleteResource && deleteProjectResource.mutate(deleteResource)
              }
            >
              {t('deletePermanently')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenameDialog
        open={renameThread !== null}
        pending={updateThreadName.isPending}
        value={renameValue}
        onChange={setRenameValue}
        onSave={saveRename}
        onClose={() => setRenameThread(null)}
      />
      <RenameDialog
        open={renameSimpleThread !== null}
        pending={renameSimpleChat.isPending}
        value={renameSimpleValue}
        onChange={setRenameSimpleValue}
        onSave={() => {
          if (renameSimpleThread && renameSimpleValue.trim()) {
            renameSimpleChat.mutate({
              id: renameSimpleThread.id,
              title: renameSimpleValue.trim(),
            });
          }
        }}
        onClose={() => setRenameSimpleThread(null)}
      />
      <AlertDialog
        open={deleteSimpleThread !== null}
        onOpenChange={(open) =>
          !open && !deleteSimpleChat.isPending && setDeleteSimpleThread(null)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cette conversation ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {deleteSimpleThread?.title} » sera supprimée définitivement.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSimpleChat.isPending}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!deleteSimpleThread || deleteSimpleChat.isPending}
              onClick={() =>
                deleteSimpleThread &&
                deleteSimpleChat.mutate(deleteSimpleThread.id)
              }
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={deleteProject !== null}
        onOpenChange={(open) =>
          !open &&
          !deleteProjectMutation.isPending &&
          (() => {
            setDeleteProject(null);
            setDeleteProjectError('');
            setDeleteProjectWorkspaceIds(new Set());
          })()
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteThisProject')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('projectDeletionWarning', { ns: 'projectArchives' })}
            </AlertDialogDescription>
            {deleteProject && (
              <div className="space-y-2 text-sm">
                <p className="font-medium">
                  {t('selectTheWorkspaceFoldersToDeletePermanently')}
                </p>
                <div className="max-h-40 space-y-2 overflow-auto rounded border border-border p-2">
                  {deleteProject.workspaces.map((workspace) => (
                    <label
                      key={workspace.id}
                      className="flex cursor-pointer items-start gap-2"
                    >
                      <input
                        type="checkbox"
                        checked={deleteProjectWorkspaceIds.has(workspace.id)}
                        onChange={(event) =>
                          setDeleteProjectWorkspaceIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(workspace.id);
                            else next.delete(workspace.id);
                            return next;
                          })
                        }
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {workspace.name}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {workspace.path}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {deleteProjectError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                {deleteProjectError}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProjectMutation.isPending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!deleteProject || deleteProjectMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (deleteProject) deleteProjectMutation.mutate(deleteProject);
              }}
            >
              {t('deletePermanently')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmDialog
        action={confirmAction}
        pending={archiveThread.isPending || compactThread.isPending}
        onConfirm={confirmCurrentAction}
        onClose={() => setConfirmAction(null)}
      />
      <ForkGoalDialog
        key={fork.prompt?.threadId ?? 'idle'}
        prompt={fork.prompt}
        pending={forkThread.isPending}
        onConfirm={fork.confirm}
        onCancel={fork.cancel}
      />
      <DeleteConversationDialog
        open={deleteTargetId !== null}
        preview={deletePreview.data ?? null}
        loading={deletePreview.isLoading}
        errorMessage={
          deletePreview.error ? getApiErrorMessage(deletePreview.error) : null
        }
        pending={deleteThread.isPending}
        currentThreadId={threadId}
        onConfirm={(preview) =>
          deleteThread.mutate({
            path: { threadId: preview.targetThreadId },
            body: buildDeleteRequestBody(preview),
          })
        }
        onClose={() => setDeleteTargetId(null)}
      />
      <BranchGraphDialog
        threadId={graphTargetId}
        onClose={() => setGraphTargetId(null)}
      />
    </div>
  );
}
