import { useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  ListChecks,
  Pencil,
  Plus,
  UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  FileActionsMenu,
  type FileMenuAction,
} from '@/components/files/file-actions-menu';
import { ProjectTaskManager } from '@/components/projects/project-task-manager';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
  type ProjectTaskBoard,
  type ProjectTaskSummary,
} from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import { useSidebarPreferences } from '@/hooks/use-sidebar-preferences';
import { showSnackbar } from '@/stores/snackbar-store';

export function ExplorerTasks({
  project,
  agentThreadId,
  revealTaskId,
  revealRequestId = 0,
}: {
  project: ProjectSummary;
  agentThreadId?: string;
  revealTaskId?: string;
  revealRequestId?: number;
}) {
  const { t } = useTranslation('workspaces');
  const session = usePlatformSession();
  const preference = useSidebarPreferences(
    session.data?.personId,
    agentThreadId,
  );
  const client = useQueryClient();
  const resources = project.resources.filter((r) => r.type === 'task_board');
  const boards = useQueries({
    queries: resources.map((r) => ({
      queryKey: ['project-resource', project.id, r.id],
      queryFn: () =>
        projectsApi<ProjectTaskBoard>(`/${project.id}/resources/${r.id}`),
      refetchInterval: 5000,
    })),
  });
  const [modal, setModal] = useState<{
    resourceId: string;
    id?: string;
    parentId?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissedReveal, setDismissedReveal] = useState<number | null>(null);
  const roots = new Set(
    boards.flatMap(
      (b) =>
        b.data?.tasks
          .filter(
            (task) =>
              task.linkedThreadId === agentThreadId && task.parentTaskId,
          )
          .map((task) => task.parentTaskId!) ?? [],
    ),
  );
  const setAssignment = async (task: ProjectTaskSummary) => {
    if (!agentThreadId || busy) return;
    setBusy(true);
    try {
      await projectsApi(
        `/${project.id}/resources/${task.resourceId}/tasks/${task.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            expectedUpdatedAt: task.updatedAt,
            executionMode: 'agent',
            linkedThreadId:
              task.linkedThreadId === agentThreadId ? null : agentThreadId,
          }),
        },
      );
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['project-resource', project.id],
        }),
        client.invalidateQueries({
          queryKey: ['project-deliverables', project.id],
        }),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
      ]);
    } catch {
      showSnackbar(t('sidebarAssignmentError'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const actions = (task: ProjectTaskSummary): FileMenuAction[] => [
    {
      id: 'edit',
      label: t('sidebarEdit'),
      icon: Pencil,
      onSelect: () => setModal({ resourceId: task.resourceId, id: task.id }),
    },
    ...(session.isAdministrator
      ? task.parentTaskId
        ? [
            {
              id: 'assign',
              label: t(
                task.linkedThreadId === agentThreadId
                  ? 'sidebarUnassign'
                  : 'assignCurrentAgent',
              ),
              icon: UserRound,
              disabled:
                busy ||
                !agentThreadId ||
                (!!task.linkedThreadId &&
                  task.linkedThreadId !== agentThreadId) ||
                (task.linkedThreadId !== agentThreadId &&
                  roots.size > 0 &&
                  !roots.has(task.parentTaskId)),
              onSelect: () => void setAssignment(task),
            },
          ]
        : [
            {
              id: 'create',
              label: t('sidebarNewSubtask'),
              icon: Plus,
              onSelect: () =>
                setModal({ resourceId: task.resourceId, parentId: task.id }),
            },
          ]
      : []),
  ];
  const row = (task: ProjectTaskSummary) => (
    <div key={task.id} className="border-b px-2 py-1 text-xs">
      <FileActionsMenu actions={actions(task)} buttonLabel={task.title}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ListChecks className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={task.title}>
            {task.title}
            {task.linkedThreadId === agentThreadId && agentThreadId && (
              <span className="ml-1 text-primary">
                · {t('sidebarThisAgent')}
              </span>
            )}
          </span>
          <span>
            {task.subtaskStatus === 'done' ? '✓' : `${task.progress} %`}
          </span>
        </div>
      </FileActionsMenu>
    </div>
  );
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t('sidebarTasks')}
    >
      <div className="flex shrink-0 items-center gap-2 border-b p-2 text-xs">
        {session.isAdministrator && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!resources.length}
            onClick={() =>
              setModal({ resourceId: resources[0].id, parentId: '' })
            }
          >
            {t('sidebarNewTask')}
          </Button>
        )}
        <select
          aria-label={t('sidebarTaskDisplay')}
          className="min-w-0 flex-1 rounded border bg-background p-1"
          disabled={!preference.ready || preference.pending}
          value={String(preference.values['mode:tasks'] ?? 'plain')}
          onChange={(e) => preference.set('mode:tasks', e.target.value)}
        >
          <option value="plain">{t('sidebarSubtaskList')}</option>
          <option value="labels">{t('sidebarLabels')}</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {preference.error && <p role="alert">{t('sidebarPreferenceError')}</p>}
        {boards.some((b) => b.isError) && (
          <p role="alert">{t('sidebarLoadError')}</p>
        )}
        {boards.some((b) => b.isLoading) && (
          <p role="status">{t('sidebarLoading')}</p>
        )}
        {boards.flatMap((b) =>
          (b.data?.tasks ?? [])
            .filter((task) => !task.parentTaskId)
            .map((parent) => {
              const children = b.data!.tasks.filter(
                (task) => task.parentTaskId === parent.id,
              );
              const open =
                preference.values[`open:task:${parent.id}`] === true ||
                (parent.id === revealTaskId &&
                  dismissedReveal !== revealRequestId);
              const definitions = (
                b.data!.resource.config.taskBoardSettings as
                  | { labels?: Array<{ id: string; name: string }> }
                  | undefined
              )?.labels;
              const labelNames = new Map(
                (Array.isArray(definitions) ? definitions : [])
                  .filter(
                    (label) =>
                      label &&
                      typeof label.id === 'string' &&
                      typeof label.name === 'string',
                  )
                  .map((label) => [label.id, label.name]),
              );
              const labels = [
                ...new Set(children.flatMap((task) => task.labels)),
              ];
              return (
                <section key={parent.id} className="mb-2 rounded-lg border">
                  <div className="flex items-center gap-2 p-2">
                    <FileActionsMenu
                      actions={actions(parent)}
                      buttonLabel={parent.title}
                    >
                      <button
                        type="button"
                        disabled={!preference.ready || preference.pending}
                        aria-expanded={open}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                        onClick={() => {
                          if (parent.id === revealTaskId)
                            setDismissedReveal(revealRequestId);
                          preference.set(`open:task:${parent.id}`, !open);
                        }}
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        <span
                          className="min-w-0 flex-1 truncate"
                          title={parent.title}
                        >
                          {parent.title}
                          <small className="block text-muted-foreground">
                            {
                              children.filter(
                                (task) => task.subtaskStatus === 'done',
                              ).length
                            }
                            /{children.length} · {t('sidebarCompleted')}
                          </small>
                        </span>
                        <span
                          className="shrink-0 tabular-nums"
                          aria-label={t('sidebarTaskProgress', {
                            title: parent.title,
                          })}
                        >
                          {parent.progress ?? 0} %
                        </span>
                      </button>
                    </FileActionsMenu>
                  </div>
                  {open && (
                    <div className="border-t">
                      {preference.values['mode:tasks'] === 'labels' ? (
                        <>
                          {labels.map((label) => (
                            <div key={label}>
                              <p className="px-2 py-1 text-xs font-medium">
                                {labelNames.get(label) ?? label}
                              </p>
                              {children
                                .filter((task) => task.labels.includes(label))
                                .map(row)}
                            </div>
                          ))}
                          {children.filter((task) => !task.labels.length)
                            .length > 0 && (
                            <div>
                              <p className="px-2 py-1 text-xs">
                                {t('sidebarNoLabel')}
                              </p>
                              {children
                                .filter((task) => !task.labels.length)
                                .map(row)}
                            </div>
                          )}
                        </>
                      ) : (
                        children.map(row)
                      )}
                      {!children.length && (
                        <p className="p-2 text-xs text-muted-foreground">
                          {t('sidebarNoSubtask')}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              );
            }),
        )}
      </div>
      {modal && (
        <ProjectTaskManager
          projectId={project.id}
          resourceId={modal.resourceId}
          initialTaskId={modal.id}
          initialCreateParentId={modal.parentId}
          modalOnly
          onModalClose={() => setModal(null)}
        />
      )}
    </section>
  );
}
