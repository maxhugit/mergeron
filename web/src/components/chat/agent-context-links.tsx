import { AgentLinkPreview } from './agent-link-preview';
import { FileText } from 'lucide-react';
import { withBasePath } from '@/base-path';
import { SubtaskProgressEditor } from './subtask-progress-editor';
import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleCheck, Circle, CircleDot, Ban, Package } from 'lucide-react';
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
  const { t: work } = useTranslation('workspaces');
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
  const [preview, setPreview] = useState<string | null>(null);
  const closeMenu = () => setPreview(null);
  const previewChange = (key: string, open: boolean) =>
    setPreview((current) => (open ? key : current === key ? null : current));
  const openSidebar = (
    tab: 'tasks' | 'deliverables',
    details: Record<string, string>,
  ) => {
    closeMenu();
    window.dispatchEvent(
      new CustomEvent('mergeron:explorer-work', {
        detail: { threadId, tab, ...details },
      }),
    );
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
          <AgentLinkPreview
            key={item.id}
            kind="deliverable"
            label={item.title}
            sidebarLabel={`${t('openDeliverableFolder')} · ${item.title}`}
            open={preview === item.id}
            onOpenChange={(open) => previewChange(item.id, open)}
            onSidebar={() => {
              onOpenDirectory?.(item.directory);
              openSidebar('deliverables', {
                directory: item.directory,
                deliverableId: item.id,
              });
            }}
            trigger={
              <>
                <Package className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
              </>
            }
          >
            <div className="space-y-1 border-b p-3">
              <p className="text-xs text-muted-foreground">
                {work('sidebarDeliverable')}
              </p>
              <button
                type="button"
                className="cursor-pointer text-left text-sm font-medium hover:underline"
                onClick={() => {
                  closeMenu();
                  setOpenedDeliverable(item.id);
                }}
              >
                {item.title}
              </button>
              <p className="text-xs text-muted-foreground">
                {work('sidebarDocumentCount', {
                  count:
                    item.documents?.filter((doc) => doc.deletedAt === null)
                      .length ?? 0,
                })}
              </p>
            </div>
            <ul className="max-h-[min(22rem,50vh)] divide-y overflow-y-auto">
              {(item.documents ?? [])
                .filter((doc) => doc.deletedAt === null)
                .map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center gap-2 p-3 text-sm"
                  >
                    <FileText
                      className="size-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <a
                      className="min-w-0 flex-1 truncate hover:underline"
                      title={doc.name}
                      href={withBasePath(
                        `/document?path=${encodeURIComponent(doc.sourcePath)}`,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {doc.name}
                    </a>
                    <span className="shrink-0 rounded bg-muted px-1.5 text-xs tabular-nums">
                      V{doc.currentVersionNumber}
                    </span>
                  </li>
                ))}
            </ul>
            {!item.documents?.some((doc) => doc.deletedAt === null) && (
              <p className="p-3 text-xs text-muted-foreground">
                {work('sidebarNoDocuments')}
              </p>
            )}
          </AgentLinkPreview>
        ))}
        {parent && !pending && !error && !incompatible && (
          <AgentLinkPreview
            kind="task"
            label={summary}
            sidebarLabel={work('sidebarOpenTask', { title: parent.title })}
            open={preview === 'tasks'}
            onOpenChange={(open) => previewChange('tasks', open)}
            onSidebar={() => openSidebar('tasks', { taskId: parent.id })}
            trigger={
              <>
                <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate tabular-nums">
                  {completed}/{children.length} {t('agentTasksCompleted')} ·{' '}
                  {t('agentTasksAssigned', { count: mine.length })}
                </span>
              </>
            }
          >
            <div className="space-y-1 border-b p-3">
              <p className="text-xs text-muted-foreground">
                {t('primaryTask')}
              </p>
              <div className="flex items-start justify-between gap-2">
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
                <span className="shrink-0 text-sm tabular-nums">
                  {parent.progress ?? 0} %
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('agentMainTaskCompleted', {
                  completed,
                  total: children.length,
                })}
              </p>
              <div
                className="h-1 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={work('sidebarTaskProgress', {
                  title: parent.title,
                })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={parent.progress ?? 0}
              >
                <div
                  className="h-full bg-blue-500"
                  style={{ width: `${parent.progress ?? 0}%` }}
                />
              </div>
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
                  <SubtaskProgressEditor
                    key={task.id}
                    projectId={project!.id}
                    task={task}
                  >
                    {(value) => (
                      <>
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
                              {value} %
                            </span>
                          </div>
                          <p className="pl-6 text-xs text-muted-foreground">
                            {label}
                          </p>
                        </button>
                      </>
                    )}
                  </SubtaskProgressEditor>
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
          </AgentLinkPreview>
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
