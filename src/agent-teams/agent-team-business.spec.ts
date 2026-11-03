import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectParticipants,
  projectAgentThreads,
  projectResources,
  projectTaskStatuses,
  projectTasks,
  projectDeliverables,
} from '../database/schema';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import type { FilesService } from '../files/files.service';
import type { ActiveFoldersService } from '../active-folders/active-folders.service';
import { ProjectsService } from '../projects/projects.service';
import type { WorkspacesManagementService } from '../threads/workspaces-management.service';
import type { ThreadMetadataService } from '../threads/thread-metadata.service';
import type { ThreadWorkspaceOverridesService } from '../threads/thread-workspace-overrides.service';
import type { ThreadsDeletionService } from '../threads/threads-deletion.service';
import type { ThreadsService } from '../threads/threads.service';
import type { SimpleChatService } from '../simple-chat/simple-chat.service';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamVisibilityService } from './agent-team-visibility.service';
import { AgentTeamBusinessService } from './agent-team-business.service';
let database: TestDatabase,
  store: AgentTeamStore,
  teams: AgentTeamsService,
  business: AgentTeamBusinessService,
  teamId: string,
  assignmentId: string;
const actor = (personId = 'admin'): PlatformIdentity => ({
  kind: 'person',
  personId,
  name: personId,
  role: personId === 'admin' ? 'administrator' : 'standard',
  active: true,
});
beforeEach(() => {
  database = createTestDatabase();
  const db = database.db;
  db.insert(people)
    .values(
      ['admin', 'member'].map((id) => ({
        id,
        reference: id,
        name: id,
        role:
          id === 'admin' ? ('administrator' as const) : ('standard' as const),
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  db.insert(projects)
    .values(
      ['p', 'other'].map((id) => ({
        id,
        name: id,
        workspacePath: '/' + id,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  db.insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: 1 })
    .run();
  db.insert(projectAgentThreads)
    .values({
      projectId: 'p',
      threadId: 'parent',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(projectResources)
    .values([
      {
        id: 'board',
        projectId: 'p',
        type: 'task_board',
        name: 'Tasks',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'private-board',
        projectId: 'p',
        type: 'task_board',
        name: 'Internal',
        config: { internal: true },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'other-board',
        projectId: 'other',
        type: 'task_board',
        name: 'Other',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'deliverables',
        projectId: 'p',
        type: 'deliverable_board',
        name: 'Deliverables',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  db.insert(projectTaskStatuses)
    .values(
      ['board', 'private-board', 'other-board'].map((resourceId) => ({
        id: resourceId + '-todo',
        resourceId,
        name: 'Unassigned',
        kind: 'unassigned',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  db.insert(projectTasks)
    .values(
      ['board', 'private-board', 'other-board'].map((resourceId) => ({
        id: resourceId + '-task',
        resourceId,
        statusId: resourceId + '-todo',
        title: 'Task',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  db.insert(projectDeliverables)
    .values(
      ['public', 'restricted'].map((id) => ({
        id,
        resourceId: 'deliverables',
        title: id,
        confidentiality:
          id === 'public' ? ('standard' as const) : ('restricted' as const),
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  const identities = new IdentityService(db),
    files = {} as FilesService,
    folders = { setFromAbsolutePath() {} } as unknown as ActiveFoldersService;
  const deliverables = new DeliverablesService(db, files, identities, folders);
  const visibility = new AgentTeamVisibilityService(
    db,
    identities,
    deliverables,
  );
  store = new AgentTeamStore(db);
  teams = new AgentTeamsService(store, identities, visibility);
  const projectDomain = new ProjectsService(
    files,
    {} as WorkspacesManagementService,
    {} as ThreadMetadataService,
    {} as ThreadWorkspaceOverridesService,
    {} as ThreadsDeletionService,
    {} as ThreadsService,
    {} as SimpleChatService,
    db,
    folders,
  );
  business = new AgentTeamBusinessService(
    db,
    teams,
    identities,
    visibility,
    projectDomain,
  );
  const team = store.create('p', 'parent', {
    requestId: 'mission',
    objective: 'Dossier',
    assignments: [{ key: 'read', role: 'Reader', instructions: 'Analyze' }],
  });
  teamId = team.id;
  assignmentId = team.assignments[0].id;
});
afterEach(() => database.sqlite.close());
const links = (
  deliverableId: string | null = 'public',
  taskId: string | null = 'board-task',
) => ({ deliverableId, assignments: [{ id: assignmentId, taskId }] });
function completed() {
  store.bind('p', teamId, assignmentId, 'child', 'parent');
  store.observe('p', teamId, 'child', 'completed', 'Suggested next step');
}
it('offers only project-visible standard deliverables and regular task boards', () => {
  const context = business.context(actor('member'), 'p', 'parent');
  expect(context.deliverables.map((d) => d.id)).toEqual(['public']);
  expect(context.boards.map((b) => b.id)).toEqual(['board']);
  expect(context.tasks.map((t) => t.id)).toEqual(['board-task']);
});
it('validates assignment ownership and target scope before changing any link', () => {
  expect(() =>
    business.links(actor(), 'p', teamId, links('public', 'other-board-task')),
  ).toThrow();
  expect(() =>
    business.links(actor(), 'p', teamId, links('public', 'private-board-task')),
  ).toThrow();
  expect(() =>
    business.links(actor(), 'p', teamId, {
      deliverableId: 'public',
      assignments: [{ id: 'another-team-assignment', taskId: 'board-task' }],
    }),
  ).toThrow();
  expect(store.read('p', teamId).deliverableId).toBeNull();
});
it('does not attach restricted content to a project-shared coordinator', () => {
  expect(() =>
    business.links(actor(), 'p', teamId, links('restricted')),
  ).toThrow('TEAM_RESTRICTED_DELIVERABLE_REQUIRES_PRIVATE_CONVERSATION');
});
it('keeps links immutable after dispatch and denies non-administrator changes', () => {
  expect(() => business.links(actor('member'), 'p', teamId, links())).toThrow();
  business.links(actor(), 'p', teamId, links());
  store.state('p', teamId, 'running');
  expect(() => business.links(actor(), 'p', teamId, links(null, null))).toThrow(
    'TEAM_LINKS_LOCKED_AFTER_LAUNCH',
  );
  expect(store.read('p', teamId).deliverableId).toBe('public');
});
it('rechecks deliverable confidentiality on every list and direct read', () => {
  business.links(actor(), 'p', teamId, links());
  expect(teams.read(actor('member'), 'p', teamId).id).toBe(teamId);
  database.db
    .update(projectDeliverables)
    .set({ confidentiality: 'restricted' })
    .where(eq(projectDeliverables.id, 'public'))
    .run();
  expect(teams.list(actor('member'), 'p', 'parent').teams).toHaveLength(0);
  expect(() => teams.read(actor('member'), 'p', teamId)).toThrow(
    'TEAM_NOT_FOUND',
  );
  expect(teams.read(actor(), 'p', teamId).id).toBe(teamId);
});
it('retains deleted target provenance instead of silently making the result public', () => {
  business.links(actor(), 'p', teamId, links());
  database.db
    .delete(projectDeliverables)
    .where(eq(projectDeliverables.id, 'public'))
    .run();
  expect(store.read('p', teamId).deliverableId).toBe('public');
  expect(() => teams.read(actor('member'), 'p', teamId)).toThrow(
    'TEAM_NOT_FOUND',
  );
  expect(teams.read(actor(), 'p', teamId).id).toBe(teamId);
});
it('creates a manual, unassigned task only after explicit confirmation and never twice', () => {
  completed();
  const input = {
    confirmed: true,
    resourceId: 'board',
    title: 'Review the dossier',
    description: 'An explicitly reviewed proposal',
  };
  expect(() =>
    business.createTask(actor(), 'p', teamId, assignmentId, {
      ...input,
      confirmed: false,
    }),
  ).toThrow('TEAM_TASK_CONFIRMATION_REQUIRED');
  expect(() =>
    business.createTask(actor('member'), 'p', teamId, assignmentId, input),
  ).toThrow();
  const task = business.createTask(actor(), 'p', teamId, assignmentId, input);
  expect(task).toMatchObject({
    executionMode: 'manual',
    agentState: 'manual',
    statusId: 'board-todo',
    assigneeId: null,
  });
  expect(
    business.createTask(actor(), 'p', teamId, assignmentId, input).id,
  ).toBe(task.id);
  expect(database.db.select().from(projectTasks).all()).toHaveLength(4);
  expect(store.read('p', teamId).assignments[0].taskId).toBe(task.id);
  expect(
    database.db
      .select()
      .from(projectDeliverables)
      .all()
      .every((d) => d.lifecycleStatus === 'draft'),
  ).toBe(true);
});
it('shows scoped contribution excerpts without changing the linked task state', () => {
  business.links(actor(), 'p', teamId, links());
  completed();
  expect(
    business.contributions(actor('member'), 'p', 'board-task').teams[0]
      .assignments[0].result,
  ).toBe('Suggested next step');
  expect(
    business.contributions(actor('member'), 'p', undefined, 'public').teams[0]
      .id,
  ).toBe(teamId);
  expect(() =>
    business.contributions(actor('member'), 'p', 'other-board-task'),
  ).toThrow();
  expect(() =>
    business.contributions(actor('member'), 'p', 'board-task', 'public'),
  ).toThrow();
  expect(
    database.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.id, 'board-task'))
      .get()?.statusId,
  ).toBe('board-todo');
});
it('revalidates deleted or newly restricted targets immediately before native dispatch', () => {
  business.links(actor(), 'p', teamId, links());
  business.assertLaunch(actor(), 'p', store.read('p', teamId));
  database.db
    .update(projectDeliverables)
    .set({ confidentiality: 'restricted' })
    .where(eq(projectDeliverables.id, 'public'))
    .run();
  expect(() =>
    business.assertLaunch(actor(), 'p', store.read('p', teamId)),
  ).toThrow('TEAM_RESTRICTED_DELIVERABLE_REQUIRES_PRIVATE_CONVERSATION');
  database.db
    .update(projectDeliverables)
    .set({ confidentiality: 'standard' })
    .where(eq(projectDeliverables.id, 'public'))
    .run();
  database.db
    .delete(projectTasks)
    .where(eq(projectTasks.id, 'board-task'))
    .run();
  expect(() =>
    business.assertLaunch(actor(), 'p', store.read('p', teamId)),
  ).toThrow('TEAM_TARGET_NOT_FOUND');
});
