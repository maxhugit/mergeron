import { describe, expect, it } from 'vitest';
import { summarizeProjects } from './project-dashboard';
import type {
  Project,
  ProjectResource,
  ProjectTask,
  ProjectTaskStatus,
} from '../database/schema';

const now = new Date(2026, 9, 18, 16).getTime();
const project = {
  id: 'p',
  name: 'Project',
  createdAt: now - 30 * 86400000,
  updatedAt: now - 30 * 86400000,
} as Project;
const resource = {
  id: 'r',
  projectId: 'p',
  name: 'Tasks',
  type: 'task_board',
  config: { taskBoardSettings: { terminalStatusIds: ['custom-end'] } },
  updatedAt: project.updatedAt,
  createdAt: project.createdAt,
} as ProjectResource;
const task = (values: Partial<ProjectTask>): ProjectTask =>
  ({
    id: 'root',
    resourceId: 'r',
    statusId: 'open',
    parentTaskId: null,
    title: 'Task',
    subtaskStatus: 'todo',
    executionMode: 'manual',
    agentState: 'manual',
    estimateMinutes: 120,
    progress: 0,
    dueAt: null,
    updatedAt: project.updatedAt,
    ...values,
  }) as ProjectTask;
const dashboard = (tasks: ProjectTask[]) =>
  summarizeProjects({
    projects: [project],
    resources: [resource],
    tasks,
    statuses: [] as ProjectTaskStatus[],
    activity: [],
    now,
  });

describe('project dashboard', () => {
  it('handles large conversation histories without exceeding the argument stack', () => {
    const result = summarizeProjects({
      projects: [project],
      resources: [resource],
      tasks: [],
      statuses: [],
      activity: Array.from({ length: 150_000 }, (_, index) => ({
        projectId: 'p',
        updatedAt: now + index,
      })),
      now,
    });
    expect(result.projects[0].lastActivityAt).toBe(now + 149_999);
  });
  it('preserves tied alert order across interleaved resources and excludes closed children from estimates', () => {
    const result = summarizeProjects({
      projects: [project],
      resources: [resource, { ...resource, id: 'second' }],
      tasks: [
        task({ id: 'b', resourceId: 'second', dueAt: now }),
        task({ id: 'a', dueAt: now }),
        task({ id: 'closed-child', parentTaskId: 'a', subtaskStatus: 'done' }),
      ],
      statuses: [],
      activity: [],
      now,
    });
    expect(result.alerts.map((alert) => alert.taskId)).toEqual(['b', 'a']);
    expect(result.projects[0].remainingMinutes).toBe(120);
  });
  it('counts remaining leaf estimates once and excludes completed or cancelled work', () => {
    const result = dashboard([
      task({ estimateMinutes: 999 }),
      task({
        id: 'child1',
        parentTaskId: 'root',
        estimateMinutes: 120,
        progress: 25,
      }),
      task({
        id: 'child2',
        parentTaskId: 'root',
        estimateMinutes: 60,
        subtaskStatus: 'cancelled',
      }),
      task({ id: 'standalone', estimateMinutes: 60, progress: 50 }),
      task({ id: 'finished', statusId: 'custom-end', estimateMinutes: 500 }),
    ]);
    expect(result.totals.remainingMinutes).toBe(120);
    expect(result.totals.openTasks).toBe(2);
    expect(result.projects[0].openSubtaskCount).toBe(1);
  });
  it('respects custom final statuses and treats today as on time', () => {
    const yesterday = new Date(2026, 9, 17, 12).getTime();
    const today = new Date(2026, 9, 18, 12).getTime();
    const result = dashboard([
      task({ id: 'late', dueAt: yesterday }),
      task({ id: 'today', dueAt: today }),
      task({ id: 'closed', dueAt: yesterday, statusId: 'custom-end' }),
      task({
        id: 'cancelled',
        parentTaskId: 'late',
        dueAt: yesterday,
        subtaskStatus: 'cancelled',
      }),
    ]);
    expect(result.totals.overdue).toBe(1);
    expect(result.projects[0].dueSoonCount).toBe(1);
    expect(result.alerts.map((a) => a.taskId)).toEqual(['late', 'today']);
  });
  it('derives recent activity from conversations and separates reviews from failures', () => {
    const input = {
      projects: [project],
      resources: [resource],
      tasks: [
        task({
          id: 'review',
          parentTaskId: 'root',
          executionMode: 'agent',
          subtaskStatus: 'review',
          agentState: 'review',
        }),
        task({
          id: 'error',
          parentTaskId: 'root',
          executionMode: 'agent',
          agentState: 'error',
        }),
      ],
      statuses: [],
      activity: [{ projectId: 'p', updatedAt: now }],
      now,
    };
    const result = summarizeProjects(input);
    expect(result.projects[0].active).toBe(true);
    expect(result.projects[0].health).toBe('risk');
    expect(result.totals.awaitingReview).toBe(1);
    expect(result.alerts[0].reason).toBe('agent_error');
    expect(dashboard([]).totals.quietProjects).toBe(1);
    expect(dashboard([]).projects[0].progress).toBe(null);
  });
});
