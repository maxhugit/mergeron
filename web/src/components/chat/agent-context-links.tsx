import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Package, FolderOpen } from 'lucide-react';
import { projectsApi, type ProjectSummary } from '@/lib/projects-api';
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
  const directTask =
    agent?.taskId && agent.taskResourceId
      ? {
          id: agent.taskId,
          resourceId: agent.taskResourceId,
          title: agent.taskTitle || t('primaryTask'),
          direct: true,
        }
      : null;
  const parentId = query.data?.tasks.find(
    (task) => task.id === directTask?.id,
  )?.parentTaskId;
  const deliverables =
    query.data?.deliverables.filter(
      (item) =>
        item.conversations.some(
          (link) => link.type === 'agent' && link.id === threadId,
        ) ||
        (!!item.primaryTaskId &&
          (item.primaryTaskId === directTask?.id ||
            item.primaryTaskId === parentId)),
    ) ?? [];
  const tasks = directTask ? [directTask] : [];
  for (const item of deliverables) {
    const task = query.data?.tasks.find(
      (task) => task.id === item.primaryTaskId,
    );
    if (task && !tasks.some((entry) => entry.id === task.id))
      tasks.push({ ...task, direct: false });
  }
  const pending = loading || (!!resource && query.isPending);
  const error = failed || (!!resource && query.isError);
  const badge =
    'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:underline focus-visible:outline focus-visible:outline-2';
  return (
    <>
      <div
        aria-label={t('agentLinkedTo')}
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs"
      >
        <span className="text-muted-foreground">{t('agentLinkedTo')}</span>
        {deliverables.map((item) => (
          <span
            key={item.id}
            className="inline-flex min-w-0 max-w-full items-center gap-1"
          >
            <button
              type="button"
              className={`${badge} border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300`}
              title={item.title}
              onClick={() => setOpenedDeliverable(item.id)}
            >
              <Package className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.title}</span>
            </button>
            {item.directory && onOpenDirectory && (
              <button
                type="button"
                className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t('openDeliverableFolder')}
                aria-label={`${t('openDeliverableFolder')} · ${item.title}`}
                onClick={() => onOpenDirectory(item.directory)}
              >
                <FolderOpen className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            className={`${badge} border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300`}
            title={task.title}
            onClick={() => setOpenedTask(task)}
          >
            <ClipboardList className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {task.direct ? t('agentDirectTask') : t('agentDeliverableTask')}:{' '}
              {task.title}
            </span>
          </button>
        ))}
        {pending && (
          <span role="status" className="text-muted-foreground">
            {t('loading')}
          </span>
        )}
        {error && (
          <span role="alert" className="text-destructive">
            {t('unableToLoadThisProjectResource')}
          </span>
        )}
        {!pending && !error && !deliverables.length && !tasks.length && (
          <span className="text-muted-foreground">{t('agentNoLinks')}</span>
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
