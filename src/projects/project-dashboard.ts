import type {
  Project,
  ProjectResource,
  ProjectTask,
  ProjectTaskStatus,
} from '../database/schema';

const DAY = 86_400_000;

/** Request-local indexes; never retain authorization-sensitive data between requests. */
function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

export function summarizeProjects(input: {
  projects: Project[];
  resources: ProjectResource[];
  tasks: ProjectTask[];
  statuses: ProjectTaskStatus[];
  activity: Array<{ projectId: string; updatedAt: number }>;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 8);
  const percent = (value: number) => Math.max(0, Math.min(100, value || 0));
  const resourcesByProject = groupBy(input.resources, (row) => row.projectId);
  const projectByResource = new Map(
    input.resources.map((row) => [row.id, row.projectId]),
  );
  const tasksByProject = groupBy(
    input.tasks.filter((row) => projectByResource.has(row.resourceId)),
    (row) => projectByResource.get(row.resourceId)!,
  );
  const statusesByResource = groupBy(input.statuses, (row) => row.resourceId);
  const activityByProject = groupBy(input.activity, (row) => row.projectId);
  const alerts: Array<{
    projectId: string;
    projectName: string;
    resourceId: string;
    taskId: string;
    title: string;
    isSubtask: boolean;
    reason: 'overdue' | 'agent_error' | 'review' | 'due_soon';
    dueAt: number | null;
  }> = [];
  const projects = input.projects
    .map((project) => {
      const resources = resourcesByProject.get(project.id) ?? [];
      // Preserve input task order, including the stable order of tied alerts.
      const tasks = tasksByProject.get(project.id) ?? [];
      const finalIds = new Set(
        resources.flatMap((resource) => {
          const config = resource.config as Record<string, unknown> | null;
          const settings = config?.taskBoardSettings as
            | Record<string, unknown>
            | undefined;
          return Array.isArray(settings?.terminalStatusIds)
            ? settings.terminalStatusIds.filter(
                (id): id is string => typeof id === 'string',
              )
            : (statusesByResource.get(resource.id) ?? [])
                .filter(
                  (s) => s.resourceId === resource.id && s.kind === 'done',
                )
                .map((s) => s.id);
        }),
      );
      const closed = (task: ProjectTask) =>
        task.parentTaskId
          ? task.subtaskStatus === 'done' || task.subtaskStatus === 'cancelled'
          : finalIds.has(task.statusId);
      const roots = tasks.filter((task) => !task.parentTaskId);
      const open = tasks.filter((task) => !closed(task));
      const openRoots = roots.filter((task) => !closed(task));
      const parentIds = new Set(tasks.map((task) => task.parentTaskId));
      const leaves = open.filter((task) => !parentIds.has(task.id));
      const overdue = open.filter(
        (task) => task.dueAt !== null && task.dueAt < today.getTime(),
      );
      const dueSoon = open.filter(
        (task) =>
          task.dueAt !== null &&
          task.dueAt >= today.getTime() &&
          task.dueAt < horizon.getTime(),
      );
      const review = open.filter(
        (task) =>
          task.parentTaskId &&
          task.executionMode === 'agent' &&
          (task.subtaskStatus === 'review' || task.agentState === 'review'),
      );
      const errors = open.filter(
        (task) => task.executionMode === 'agent' && task.agentState === 'error',
      );
      // A spread into Math.max can exceed V8's argument limit on large boards.
      let latestActivity = Math.max(project.updatedAt, project.createdAt);
      for (const row of resources)
        latestActivity = Math.max(latestActivity, row.updatedAt);
      for (const row of tasks)
        latestActivity = Math.max(latestActivity, row.updatedAt);
      for (const row of activityByProject.get(project.id) ?? [])
        latestActivity = Math.max(latestActivity, row.updatedAt);
      const errorTasks = new Set(errors);
      const overdueTasks = new Set(overdue);
      const reviewTasks = new Set(review);
      const dueSoonTasks = new Set(dueSoon);
      for (const task of open) {
        const reason = errorTasks.has(task)
          ? 'agent_error'
          : overdueTasks.has(task)
            ? 'overdue'
            : reviewTasks.has(task)
              ? 'review'
              : dueSoonTasks.has(task)
                ? 'due_soon'
                : null;
        if (reason)
          alerts.push({
            projectId: project.id,
            projectName: project.name,
            resourceId: task.resourceId,
            taskId: task.id,
            title: task.title,
            isSubtask: !!task.parentTaskId,
            reason,
            dueAt: task.dueAt,
          });
      }
      return {
        id: project.id,
        name: project.name,
        lastActivityAt: latestActivity,
        active: latestActivity >= now - 14 * DAY,
        health:
          overdue.length || errors.length
            ? ('risk' as const)
            : review.length || dueSoon.length
              ? ('attention' as const)
              : ('clear' as const),
        taskCount: roots.length,
        openTaskCount: openRoots.length,
        openSubtaskCount: open.filter((t) => t.parentTaskId).length,
        overdueCount: overdue.length,
        dueSoonCount: dueSoon.length,
        reviewCount: review.length,
        agentErrorCount: errors.length,
        progress: roots.length
          ? Math.round(
              roots.reduce(
                (sum, task) =>
                  sum + (closed(task) ? 100 : percent(task.progress)),
                0,
              ) / roots.length,
            )
          : null,
        remainingMinutes: Math.round(
          leaves.reduce(
            (sum, task) =>
              sum +
              Math.max(0, task.estimateMinutes) *
                (1 - percent(task.progress) / 100),
            0,
          ),
        ),
        unestimatedCount: leaves.filter((t) => t.estimateMinutes <= 0).length,
        nextDueAt:
          open
            .filter((t) => t.dueAt !== null && t.dueAt >= today.getTime())
            .sort((a, b) => a.dueAt! - b.dueAt!)[0]?.dueAt ?? null,
        resources: resources.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
        })),
      };
    })
    .sort(
      (a, b) =>
        ({ risk: 0, attention: 1, clear: 2 })[a.health] -
          { risk: 0, attention: 1, clear: 2 }[b.health] ||
        b.lastActivityAt - a.lastActivityAt,
    );
  const sum = (
    key:
      | 'openTaskCount'
      | 'overdueCount'
      | 'reviewCount'
      | 'remainingMinutes'
      | 'unestimatedCount',
  ) => projects.reduce((total, p) => total + p[key], 0);
  const order = { agent_error: 0, overdue: 1, review: 2, due_soon: 3 };
  alerts.sort(
    (a, b) =>
      order[a.reason] - order[b.reason] ||
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity),
  );
  return {
    generatedAt: now,
    projects,
    alerts,
    totals: {
      projects: projects.length,
      activeProjects: projects.filter((p) => p.active).length,
      quietProjects: projects.filter((p) => !p.active).length,
      atRiskProjects: projects.filter((p) => p.health === 'risk').length,
      openTasks: sum('openTaskCount'),
      overdue: sum('overdueCount'),
      awaitingReview: sum('reviewCount'),
      remainingMinutes: sum('remainingMinutes'),
      unestimated: sum('unestimatedCount'),
    },
  };
}
