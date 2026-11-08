import { SubtaskProgressEditor } from './subtask-progress-editor';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  CircleCheck,
  Circle,
  CircleDot,
  Ban,
  ChevronDown,
  Package,
  FolderOpen,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  projectsApi,
  type ProjectSummary,
  type ProjectTaskBoard,
} from '@/lib/projects-api';
import type { DeliverablesBoard } from '@/lib/deliverables-api';

const TaskModal = lazy(() =>
  import('@/components/projects/project-task-manager').then((module) => ({
    default: module.ProjectTaskManager,
  })),
);
const DeliverableModal = lazy(() =>
  import('@/components/projects/project-deliverables-manager').then(
    (module) => ({ default: module.ProjectDeliverablesManager }),
  ),
);

export function AgentContextLinks({
  threadId,
  project,
  loading,
  failed,
  onOpenDirectory,
}: {
  threadId: string;
  project?: ProjectSummary;
  loading: boolean;
  failed: boolean;
  onOpenDirectory?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const resource = project?.resources.find(
    (item) => item.type === 'deliverable_board',
  );
  const query = useQuery({
    queryKey: ['project-deliverables', project?.id, resource?.id],
    queryFn: () =>
      projectsApi<DeliverablesBoard>(
        `/${project!.id}/resources/${resource!.id}/deliverables`,
      ),
    enabled: !!project && !!resource,
    // Refresh only mounted, visible views; runtime projection itself lives on the server.
    refetchInterval: 5_000,
  });
  const [openedTask, setOpenedTask] = useState<{
    id: string;
    resourceId: string;
  } | null>(null);
  const [openedDeliverable, setOpenedDeliverable] = useState<string | null>(
    null,
  );
  const agent = project?.agentThreads?.find(
    (item) => item.threadId === threadId,
  );
  const fallbackResource =
    agent?.taskResourceId ??
    project?.resources.find((item) => item.type === 'task_board')?.id;
  const taskQuery = useQuery({
    queryKey: ['project-resource', project?.id, fallbackResource],
    queryFn: () =>
      projectsApi<ProjectTaskBoard>(
        `/${project!.id}/resources/${fallbackResource}`,
      ),
    enabled: !!project && !resource && !!fallbackResource,
    refetchInterval: 5_000,
  });
  const allTasks = query.data?.tasks ?? taskQuery.data?.tasks ?? [];
  const deliverables =
    query.data?.deliverables.filter((item) =>
      item.linkedAgentIds
        ? item.linkedAgentIds.includes(threadId)
        : item.conversations.some(
            (link) => link.type === 'agent' && link.id === threadId,
          ),
    ) ?? [];
  const assigned = allTasks.filter(
    (task) => task.parentTaskId && task.linkedThreadId === threadId,
  );
  const directTask = allTasks.find((task) => task.id === agent?.taskId);
  const parentId =
    assigned[0]?.parentTaskId ??
    directTask?.parentTaskId ??
    directTask?.id ??
    deliverables.find((item) => item.primaryTaskId)?.primaryTaskId;
  const parent = allTasks.find((task) => task.id === parentId);
  const children = parent
    ? allTasks.filter(
        (task) =>
          task.parentTaskId === parent.id &&
          task.resourceId === parent.resourceId,
      )
    : [];
  const completed = children.filter(
    (task) => task.subtaskStatus === 'done',
  ).length;
  const mine = children.filter((task) => task.linkedThreadId === threadId);
  const others = children.filter((task) => task.linkedThreadId !== threadId);
  const incompatible = assigned.some((task) => task.parentTaskId !== parentId);
  const pending =
    loading ||
    (resource ? query.isPending : !!fallbackResource && taskQuery.isPending);
  const error =
    failed ||
    (resource ? query.isError : !!fallbackResource && taskQuery.isError);
  const [menuOpen, setMenuOpen] = useState(false);
  const pinned = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const cancelHover = () => clearTimeout(hoverTimer.current);
  const closeMenu = () => {
    cancelHover();
    pinned.current = false;
    setMenuOpen(false);
  };
  const leaveMenu = () => {
    cancelHover();
    if (!pinned.current)
      hoverTimer.current = setTimeout(() => setMenuOpen(false), 180);
  };
  const summary = t('agentTaskSummary', {
    completed,
    total: children.length,
    assigned: mine.length,
  });
  return (
    <>
      <div
        aria-label={t('agentLinkedTo')}
        className="flex min-w-0 shrink-0 flex-nowrap items-center gap-2 border-b px-2 py-2 text-xs sm:px-4"
      >
        <span className="hidden shrink-0 text-muted-foreground sm:inline">
          {t('agentLinkedTo')}
        </span>
        {deliverables.map((item) => (
          <div
            key={item.id}
            role="group"
            aria-label={item.title}
            className="inline-flex min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          >
            <button
              type="button"
              className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 py-1 text-left hover:underline"
              title={item.title}
              onClick={() => {
                closeMenu();
                setOpenedDeliverable(item.id);
              }}
            >
              <Package className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.title}</span>
            </button>
            {item.directory && onOpenDirectory && (
              <button
                type="button"
                className="shrink-0 cursor-pointer border-l border-blue-500/20 px-2 hover:bg-blue-500/10"
                title={t('openDeliverableFolder')}
                aria-label={`${t('openDeliverableFolder')} · ${item.title}`}
                onClick={() => {
                  closeMenu();
                  onOpenDirectory(item.directory);
                }}
              >
                <FolderOpen className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
        {parent && !pending && !error && !incompatible && (
          <Popover
            open={menuOpen}
            onOpenChange={(value) => {
              if (!value) pinned.current = false;
              setMenuOpen(value);
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-violet-500/25 bg-violet-500/10 px-2 py-1 text-violet-700 dark:text-violet-300"
                aria-label={summary}
                title={summary}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') {
                    cancelHover();
                    setMenuOpen(true);
                  }
                }}
                onPointerLeave={leaveMenu}
                onClick={(event) => {
                  event.preventDefault();
                  cancelHover();
                  if (menuOpen && !pinned.current) pinned.current = true;
                  else {
                    pinned.current = !menuOpen;
                    setMenuOpen(!menuOpen);
                  }
                }}
              >
                <CircleCheck className="size-3.5" aria-hidden="true" />
                <span className="tabular-nums">
                  {completed}/{children.length}
                </span>
                <span className="hidden sm:inline">
                  {t('agentTasksCompleted')}
                </span>
                <span aria-hidden="true">·</span>
                <span>{t('agentTasksAssigned', { count: mine.length })}</span>
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[min(29rem,calc(100vw-1rem))] overflow-hidden p-0"
              onOpenAutoFocus={(event) => event.preventDefault()}
              onPointerEnter={cancelHover}
              onFocusCapture={() => {
                pinned.current = true;
                cancelHover();
              }}
              onPointerLeave={leaveMenu}
              aria-label={t('agentAssignedSubtasks')}
            >
              <div className="space-y-1 border-b p-3">
                <p className="text-xs text-muted-foreground">
                  {t('primaryTask')}
                </p>
                <button
                  type="button"
                  className="cursor-pointer text-left text-sm font-medium hover:underline"
                  onClick={() => {
                    closeMenu();
                    setOpenedTask(parent);
                  }}
                >
                  {parent.title}
                </button>
                <p className="text-xs text-muted-foreground">
                  {t('agentMainTaskCompleted', {
                    completed,
                    total: children.length,
                  })}
                </p>
              </div>
              <p className="bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('agentAssignedSubtasks')} · {mine.length}
              </p>
              <div className="max-h-[min(22rem,50vh)] overflow-y-auto divide-y">
                {mine.map((task) => {
                  const state = task.subtaskStatus ?? 'todo';
                  const Icon =
                    state === 'done'
                      ? CircleCheck
                      : state === 'cancelled'
                        ? Ban
                        : ['started', 'review'].includes(state)
                          ? CircleDot
                          : Circle;
                  const label = {
                    todo: t('toDo'),
                    started: t('inProgress'),
                    review: t('agentSubtaskReview'),
                    done: t('transferStatusSuccess'),
                    cancelled: t('cancelled'),
                  }[state];
                  return (
                    <div key={task.id}>
                      <button
                        type="button"
                        className="block w-full cursor-pointer space-y-2 p-3 text-left hover:bg-accent"
                        onClick={() => {
                          closeMenu();
                          setOpenedTask(task);
                        }}
                      >
                        <div className="flex items-start gap-2 text-sm">
                          <Icon
                            className={`mt-0.5 size-4 shrink-0 ${state === 'done' ? 'text-green-700 dark:text-green-300' : state === 'started' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 break-words">
                            {task.title}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {task.progress} %
                          </span>
                        </div>
                        <p className="pl-6 text-xs text-muted-foreground">
                          {label}
                        </p>
                        <div
                          className="ml-6 h-1 overflow-hidden rounded-full bg-muted"
                          aria-hidden="true"
                        >
                          <div
                            className={
                              state === 'done'
                                ? 'h-full bg-green-600 dark:bg-green-400'
                                : 'h-full bg-violet-500'
                            }
                            style={{
                              width: `${Math.max(0, Math.min(100, task.progress))}%`,
                            }}
                          />
                        </div>
                      </button>
                      {project && (
                        <SubtaskProgressEditor
                          projectId={project.id}
                          task={task}
                        />
                      )}
                    </div>
                  );
                })}
                {!mine.length && (
                  <p className="p-3 text-sm text-muted-foreground">
                    {t('agentNoAssignedSubtasks')}
                  </p>
                )}
              </div>
              {others.length > 0 && (
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  {t('agentOtherSubtasks', {
                    count: others.length,
                    completed: others.filter(
                      (task) => task.subtaskStatus === 'done',
                    ).length,
                  })}
                </p>
              )}
            </PopoverContent>
          </Popover>
        )}
        {pending && (
          <span role="status" className="truncate text-muted-foreground">
            {t('loading')}
          </span>
        )}
        {(error || incompatible) && (
          <span
            role="alert"
            className="min-w-0 truncate text-destructive"
            title={t(
              incompatible
                ? 'agentDifferentMainTasks'
                : 'unableToLoadThisProjectResource',
            )}
          >
            {t(
              incompatible
                ? 'agentDifferentMainTasks'
                : 'unableToLoadThisProjectResource',
            )}
          </span>
        )}
        {!pending && !error && !deliverables.length && !parent && (
          <span className="truncate text-muted-foreground">
            {project?.resources
              .filter(
                (r) =>
                  r.type === 'deliverable_board' || r.type === 'task_board',
              )
              .map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className="mr-2 rounded border px-2 py-1 text-primary"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('mergeron:explorer-work', {
                        detail: {
                          threadId,
                          tab:
                            r.type === 'task_board' ? 'tasks' : 'deliverables',
                        },
                      }),
                    )
                  }
                >
                  {t(
                    r.type === 'task_board'
                      ? 'sidebarLinkTasks'
                      : 'sidebarLinkDeliverable',
                    { ns: 'workspaces' },
                  )}
                </button>
              ))}
            {!project?.resources.some(
              (r) => r.type === 'deliverable_board' || r.type === 'task_board',
            ) && t('agentNoLinks')}
          </span>
        )}
      </div>
      {openedDeliverable && project && resource && (
        <Suspense fallback={<span role="status">{t('loading')}</span>}>
          <DeliverableModal
            key={`${threadId}:${openedDeliverable}`}
            projectId={project.id}
            resourceId={resource.id}
            initialDeliverableId={openedDeliverable}
            modalOnly
            onModalClose={() => setOpenedDeliverable(null)}
          />
        </Suspense>
      )}
      {openedTask && project && (
        <Suspense fallback={<span role="status">{t('loading')}</span>}>
          <TaskModal
            key={`${threadId}:${openedTask.id}`}
            projectId={project.id}
            resourceId={openedTask.resourceId}
            initialTaskId={openedTask.id}
            modalOnly
            onModalClose={() => setOpenedTask(null)}
          />
        </Suspense>
      )}
    </>
  );
}
