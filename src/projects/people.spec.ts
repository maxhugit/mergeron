import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectResources,
  projectTaskStatuses,
  projectTasks,
  projectTaskActivity,
  projectWorkspaces,
} from '../database/schema';
import { ProjectsService } from './projects.service';
import {
  PROJECT_PLAN_SCHEMA,
  PROJECT_TASKS_SCHEMA,
} from './project-ai-schemas';

describe('people and task responsibility', () => {
  let database: TestDatabase;
  let service: ProjectsService;
  let workspacePath: string;
  const runProjectStructuredPrompt =
    vi.fn<
      (input: {
        instructions: string;
        outputSchema: unknown;
        prompt: string;
        cwd: string;
      }) => Promise<string>
    >();
  beforeEach(async () => {
    runProjectStructuredPrompt.mockReset();
    database = createTestDatabase();
    workspacePath = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'people-project-'),
    );
    service = new ProjectsService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      { runProjectStructuredPrompt } as never,
      null as never,
      database.db,
    );
    const timestamp = Date.now();
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'Test',
        workspacePath,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'workspace',
        projectId: 'p',
        name: 'Principal',
        path: workspacePath,
        primary: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    database.db
      .insert(projectResources)
      .values({
        id: 'r',
        projectId: 'p',
        type: 'task_board',
        name: 'Tasks',
        config: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    database.db
      .insert(projectTaskStatuses)
      .values({
        id: 's',
        resourceId: 'r',
        name: 'Unassigned',
        color: 'slate',
        kind: 'unassigned',
        position: 0,
        system: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  });
  afterEach(async () => {
    database.sqlite.close();
    await fsp.rm(workspacePath, { recursive: true, force: true });
  });
  it('plans only manual top-level tasks and preserves their dependencies without creating them', async () => {
    runProjectStructuredPrompt.mockResolvedValue(
      JSON.stringify({
        tasks: [
          {
            title: 'Cadrer',
            parentTitle: '',
            executionMode: 'agent',
            dependsOnTitles: [],
          },
          {
            title: 'Concevoir',
            parentTitle: '',
            executionMode: 'manual',
            dependsOnTitles: ['Cadrer'],
          },
        ],
      }),
    );
    const plan = await service.suggestTasks(
      'p',
      'r',
      'Préparer un projet avec ses sous-tâches',
    );
    expect(runProjectStructuredPrompt.mock.calls[0][0].outputSchema).toBe(
      PROJECT_PLAN_SCHEMA,
    );
    expect(runProjectStructuredPrompt.mock.calls[0][0].instructions).toContain(
      'Ne crée aucune sous-tâche',
    );
    expect(
      plan.tasks.map((task) => ({
        title: task.title,
        parentTitle: task.parentTitle,
        executionMode: task.executionMode,
        dependsOnTitles: task.dependsOnTitles,
      })),
    ).toEqual([
      {
        title: 'Cadrer',
        parentTitle: '',
        executionMode: 'manual',
        dependsOnTitles: [],
      },
      {
        title: 'Concevoir',
        parentTitle: '',
        executionMode: 'manual',
        dependsOnTitles: ['Cadrer'],
      },
    ]);
    expect(database.db.select().from(projectTasks).all()).toHaveLength(0);
  });
  it('rejects a nested AI plan rather than silently promoting subtasks to main tasks', async () => {
    runProjectStructuredPrompt.mockResolvedValue(
      JSON.stringify({
        tasks: [{ title: 'Détailler', parentTitle: 'Cadrer' }],
      }),
    );
    await expect(
      service.suggestTasks('p', 'r', 'Préparer un projet'),
    ).rejects.toThrow('uniquement des tâches principales');
    expect(database.db.select().from(projectTasks).all()).toHaveLength(0);
  });
  it('still allows explicit decomposition of a task into agent subtasks in a second step', async () => {
    const task = service.createTask('p', 'r', { title: 'Cadrer' });
    runProjectStructuredPrompt.mockResolvedValue(
      JSON.stringify({
        tasks: [
          {
            title: 'Rechercher',
            executionMode: 'agent',
            parentTitle: '',
            dependsOnTitles: [],
          },
        ],
      }),
    );
    const result = await service.suggestSubtasks('p', 'r', task.id, {});
    expect(runProjectStructuredPrompt.mock.calls[0][0].outputSchema).toBe(
      PROJECT_TASKS_SCHEMA,
    );
    expect(result.tasks[0]).toMatchObject({
      title: 'Rechercher',
      parentTitle: 'Cadrer',
      executionMode: 'agent',
      dependsOnTitles: [],
    });
    expect(database.db.select().from(projectTasks).all()).toHaveLength(1);
  });
  const person = (reference = 'MD-001', name = 'Marie Dupont') => ({
    reference,
    firstName: name.split(' ')[0],
    lastName: name.split(' ').slice(1).join(' ') || 'Test',
    email: `${reference.toLowerCase()}@example.com`,
    phone: '0600000000',
  });

  it('migrates existing tasks with a nullable assignee and enforces identity uniqueness', () => {
    const first = service.savePerson(person());
    expect(first.active).toBe(true);
    expect(() => service.savePerson(person('md-001', 'Other'))).toThrow(
      'Manual reference already exists',
    );
    expect(() =>
      service.savePerson({ ...person('B'), email: 'invalid' }),
    ).toThrow('Invalid email');
    const task = service.createTask('p', 'r', { title: 'Legacy-compatible' });
    expect(task.assigneeId).toBeNull();
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
  it('only allows active participants and keeps parent/subtask assignments independent', () => {
    const first = service.savePerson(person());
    const second = service.savePerson(person('AL-002', 'Alex'));
    expect(() =>
      service.createTask('p', 'r', {
        title: 'Not a member',
        assigneeId: first.id,
      }),
    ).toThrow('active project participant');
    service.addParticipant('p', first.id);
    service.addParticipant('p', second.id);
    expect(service.isParticipant('p', first.id)).toBe(true);
    const parent = service.createTask('p', 'r', {
      title: 'Parent',
      assigneeId: first.id,
    });
    const child = service.createTask('p', 'r', {
      title: 'Child',
      parentTaskId: parent.id,
      assigneeId: second.id,
      executionMode: 'agent',
    });
    expect(child.assigneeId).toBe(second.id);
    expect(child.executionMode).toBe('agent');
    expect(
      database.db
        .select()
        .from(projectTasks)
        .all()
        .find((t) => t.id === parent.id)?.assigneeId,
    ).toBe(first.id);
    expect(
      service.participants('p').find((p) => p.personId === second.id)
        ?.openAssignmentCount,
    ).toBe(1);
  });
  it('preserves historical assignments after removal or deactivation but rejects new ones', async () => {
    const first = service.savePerson(person());
    service.addParticipant('p', first.id);
    const task = service.createTask('p', 'r', {
      title: 'Existing',
      assigneeId: first.id,
    });
    service.removeParticipant('p', first.id);
    const edited = await service.updateTask('p', 'r', task.id, {
      description: 'Edit after departure',
      assigneeId: first.id,
    });
    expect(edited.assigneeId).toBe(first.id);
    expect(() =>
      service.createTask('p', 'r', { title: 'New', assigneeId: first.id }),
    ).toThrow('active project participant');
    service.addParticipant('p', first.id);
    service.savePerson({ active: false }, first.id);
    expect(() =>
      service.createTask('p', 'r', { title: 'Inactive', assigneeId: first.id }),
    ).toThrow('active project participant');
    expect(
      (
        await service.updateTask('p', 'r', task.id, {
          description: 'Still editable',
          assigneeId: first.id,
        })
      ).assigneeId,
    ).toBe(first.id);
  });
  it('records readable assignment changes and allows unassigning departed participants', async () => {
    const first = service.savePerson(person());
    service.addParticipant('p', first.id);
    const task = service.createTask('p', 'r', { title: 'Task' });
    await service.updateTask('p', 'r', task.id, { assigneeId: first.id });
    service.removeParticipant('p', first.id);
    await service.updateTask('p', 'r', task.id, { assigneeId: null });
    const changes = database.db
      .select()
      .from(projectTaskActivity)
      .all()
      .filter((a) => a.action === 'updated')
      .map((a) => a.changes.assigneeId);
    expect(changes).toEqual([
      { before: null, after: 'Marie Dupont (MD-001)' },
      { before: 'Marie Dupont (MD-001)', after: null },
    ]);
  });
  it('configures one project manager and reusable project people groups', () => {
    const first = service.savePerson(person());
    const second = service.savePerson(person('AL-002', 'Alex Martin'));
    service.addParticipant('p', first.id);
    service.addParticipant('p', second.id);

    service.configureProjectManager('p', first.id);
    expect(service.peopleConfiguration('p').projectManagerPersonId).toBe(
      first.id,
    );
    service.configureProjectManager('p', second.id);
    expect(service.peopleConfiguration('p').projectManagerPersonId).toBe(
      second.id,
    );

    const created = service.savePersonGroup('p', {
      name: 'Direction',
      memberIds: [first.id, second.id],
    });
    expect(created.groups).toHaveLength(1);
    expect(created.groups[0]).toMatchObject({
      name: 'Direction',
    });
    expect(new Set(created.groups[0].memberIds)).toEqual(
      new Set([first.id, second.id]),
    );
    expect(() =>
      service.savePersonGroup('p', {
        name: 'direction',
        memberIds: [],
      }),
    ).toThrow('Group name already exists');
  });
  it('clears project responsibilities when a participant is removed', () => {
    const first = service.savePerson(person());
    service.addParticipant('p', first.id);
    service.configureProjectManager('p', first.id);
    service.savePersonGroup('p', {
      name: 'Reviewers',
      memberIds: [first.id],
    });

    service.removeParticipant('p', first.id);

    const configuration = service.peopleConfiguration('p');
    expect(configuration.projectManagerPersonId).toBeNull();
    expect(configuration.groups[0]?.memberIds).toEqual([]);
  });
  it('creates deliverable execution subtasks in a hidden task manager', () => {
    database.db.delete(projectResources).run();
    const subtask = service.createDeliverableExecutionSubtask(
      'p',
      'deliverable-1',
      'Release note',
      'Ready to publish',
      undefined,
      'Write the release note',
    );
    const parent = database.db
      .select()
      .from(projectTasks)
      .all()
      .find((task) => task.id === subtask.parentTaskId);
    const internalResource = database.db
      .select()
      .from(projectResources)
      .all()
      .find((resource) => resource.id === subtask.resourceId);
    expect(subtask).toMatchObject({
      title: 'Write the release note',
      executionMode: 'agent',
    });
    expect(parent?.labels).toContain('mergeron:deliverable:deliverable-1');
    expect(internalResource?.config).toEqual({
      internal: true,
      purpose: 'deliverable_execution',
    });
    expect(service.createResource('p', { type: 'task_board' }).name).toBe(
      'Gestionnaire de tâches',
    );
  });
});
