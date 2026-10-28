import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import type { ModuleRef } from '@nestjs/core';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectAgentThreads,
  projectResources,
  projectTasks,
  projectTaskStatuses,
  projectParticipants,
  projectActivity,
  projectAgentToolRequests,
  projectWorkspaces,
  projectPersonGroups,
} from '../database/schema';
import { accessContext } from '../auth/access-context';
import { IdentityService } from '../auth/identity.service';
import { FilesService } from '../files/files.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { ProjectsService } from '../projects/projects.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import type { SettingsService } from '../settings/settings.service';
import { ProjectAgentToolsService } from './project-agent-tools.service';

describe('project context and business tools', () => {
  let database: TestDatabase;
  let root: string;
  let tools: ProjectAgentToolsService;
  let identities: IdentityService;
  let deliverables: DeliverablesService;
  let domain: ProjectsService;

  const asPerson = <T>(id: string, operation: () => T) =>
    accessContext.run(
      { identity: identities.resolvePerson(id), identities },
      operation,
    );
  const create = (
    tool = 'create_task',
    extra: Record<string, unknown> = {},
  ) => ({
    tool,
    requestId: 'new-1',
    resourceId: tool === 'create_task' ? 'tasks' : 'deliverables',
    title: 'Presentation',
    userRequest: 'Create a presentation for the customer',
    ...extra,
  });

  beforeEach(async () => {
    database = createTestDatabase();
    root = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), 'project-tools-')),
    );
    const now = Date.now();
    database.db
      .insert(people)
      .values([
        {
          id: 'admin',
          reference: 'admin',
          name: 'Administrator',
          role: 'administrator' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'reader',
          reference: 'reader',
          name: 'Reader',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    database.db
      .insert(projects)
      .values([
        {
          id: 'p',
          name: 'Tests 2',
          workspacePath: root,
          workspaceLayoutVersion: 3,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'other',
          name: 'Other project',
          workspacePath: root + '-other',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    database.db
      .insert(projectParticipants)
      .values({ projectId: 'p', personId: 'reader', createdAt: now })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'primary',
        projectId: 'p',
        name: 'Primary',
        path: root,
        primary: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectPersonGroups)
      .values({
        id: 'secret-group',
        projectId: 'p',
        name: 'Secret',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: root,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectResources)
      .values([
        {
          id: 'tasks',
          projectId: 'p',
          type: 'task_board',
          name: 'Tasks',
          config: {},
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'deliverables',
          projectId: 'p',
          type: 'deliverable_board',
          name: 'Deliverables',
          config: {},
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'internal',
          projectId: 'p',
          type: 'task_board',
          name: 'Internal execution',
          config: { internal: true },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'foreign',
          projectId: 'other',
          type: 'task_board',
          name: 'Foreign',
          config: {},
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    database.db
      .insert(projectTaskStatuses)
      .values(
        ['tasks', 'internal', 'foreign'].map((resourceId) => ({
          id: resourceId + '-todo',
          resourceId,
          name: 'To do',
          kind: 'unassigned',
          position: 0,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    const files = new FilesService(
      {
        getStringSetting: (key: string) =>
          key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
        getSetting: () => ({ value: '' }),
        onChange: () => () => {},
      } as unknown as SettingsService,
      database.db,
    );
    identities = new IdentityService(database.db);
    deliverables = new DeliverablesService(
      database.db,
      files,
      identities,
      new ActiveFoldersService(database.db),
    );
    domain = new ProjectsService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      database.db,
    );
    tools = new ProjectAgentToolsService(database.db, deliverables, {
      get: () => domain,
    } as unknown as ModuleRef);
  });

  afterEach(async () => {
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('refreshes context for an existing conversation and uses its binding, never cwd', async () => {
    await asPerson('admin', () => tools.execute('agent', create()));
    const context = asPerson('admin', () =>
      tools.context('agent', '/unrelated/git'),
    )!;
    expect(context).toContain('Tests 2');
    expect(context).not.toContain('Presentation');
    expect(context).toContain('/unrelated/git');
    expect(context).not.toContain('Foreign');
    expect(context).not.toContain('Internal execution');
    database.db
      .update(projects)
      .set({ name: 'Renamed' })
      .where(eq(projects.id, 'p'))
      .run();
    expect(asPerson('admin', () => tools.context('agent'))).toContain(
      'Renamed',
    );
    expect(tools.context('unbound')).toBeNull();
  });

  it('paginates and searches live tasks without returning full descriptions', async () => {
    await asPerson('admin', async () => {
      for (let n = 0; n < 55; n++)
        domain.createTask('p', 'tasks', {
          title: 'Task ' + n,
          description: 'Long description',
        });
      const first = (await tools.execute('agent', { tool: 'list_tasks' })) as {
        items: unknown[];
        total: number;
        nextOffset: number;
      };
      expect(first.items).toHaveLength(50);
      expect(first.total).toBe(55);
      expect(first.nextOffset).toBe(50);
      expect(JSON.stringify(first)).not.toContain('Long description');
      expect(
        (
          (await tools.execute('agent', {
            tool: 'list_tasks',
            offset: 50,
          })) as { items: unknown[] }
        ).items,
      ).toHaveLength(5);
      expect(
        (
          (await tools.execute('agent', {
            tool: 'list_tasks',
            query: 'Task 54',
          })) as { items: unknown[] }
        ).items,
      ).toHaveLength(1);
      const context = tools.context('agent')!;
      const snapshot = JSON.parse(context.split('\n')[2]) as {
        tasks?: unknown;
      };
      expect(snapshot.tasks).toBeUndefined();
      expect(context).not.toContain('Task 54');
    });
  });

  it('filters restricted deliverables from lists, details and injected context', async () => {
    const secret = await asPerson('admin', () =>
      deliverables.create('p', 'deliverables', {
        title: 'Secret roadmap',
        confidentiality: 'restricted',
        authorizedGroupIds: ['secret-group'],
      }),
    );
    await asPerson('admin', () =>
      deliverables.create('p', 'deliverables', {
        title: 'Public presentation',
      }),
    );
    await asPerson('reader', async () => {
      expect(tools.context('agent')).not.toContain('Secret roadmap');
      const list = (await tools.execute('agent', {
        tool: 'list_deliverables',
      })) as { total: number };
      expect(list.total).toBe(1);
      await expect(
        tools.execute('agent', { tool: 'get_deliverable', id: secret.id }),
      ).rejects.toThrow('unavailable');
    });
  });

  it('creates real tasks and deliverables with durable idempotency and audit', async () => {
    await asPerson('admin', async () => {
      const first = (await tools.execute('agent', create())) as { id: string };
      const fresh = new ProjectAgentToolsService(database.db, deliverables, {
        get: () => domain,
      } as unknown as ModuleRef);
      expect(await fresh.execute('agent', create())).toEqual(first);
      expect(database.db.select().from(projectTasks).all()).toHaveLength(1);
      const item = (await tools.execute(
        'agent',
        create('create_deliverable', { requestId: 'new-deliverable' }),
      )) as { id: string; status: string };
      expect(item.status).toBe('created');
      expect(deliverables.get('p', 'deliverables', item.id).title).toBe(
        'Presentation',
      );
      const audits = database.db
        .select()
        .from(projectActivity)
        .all()
        .filter((e) => e.action === 'agent_created');
      expect(audits).toHaveLength(2);
      expect(audits[0].actorPersonId).toBe('admin');
      expect(audits[0].details.threadId).toBe('agent');
      expect(
        database.db.select().from(projectTasks).all()[0].parentTaskId,
      ).toBeNull();
      await expect(
        tools.execute('agent', create('create_task', { title: 'Changed' })),
      ).rejects.toThrow('already used');
    });
  });

  it('fails closed without identity, after role revocation or without project access', async () => {
    await expect(
      tools.execute('agent', { tool: 'get_project' }),
    ).rejects.toThrow('authenticated');
    await asPerson('reader', async () => {
      await expect(tools.execute('agent', create())).rejects.toThrow(
        'Administrator',
      );
      database.db.delete(projectParticipants).run();
      await expect(
        tools.execute('agent', { tool: 'get_project' }),
      ).rejects.toThrow();
    });
    await asPerson('admin', async () => {
      database.db
        .update(people)
        .set({ active: false })
        .where(eq(people.id, 'admin'))
        .run();
      await expect(tools.execute('agent', create())).rejects.toThrow();
    });
  });

  it.each([
    { projectId: 'other' },
    { resourceId: 'foreign' },
    { resourceId: 'internal' },
    { resourceId: 'missing' },
    { resourceId: 'deliverables' },
    { title: '' },
    { title: 'x'.repeat(201) },
    { parentTaskId: 'foreign-task' },
    { userRequest: '' },
    { path: '/etc/passwd' },
    { conversations: [] },
  ])('rejects unsafe or invalid creation fields: %j', async (extra) => {
    await asPerson('admin', () =>
      expect(
        tools.execute('agent', create('create_task', extra)),
      ).rejects.toThrow(),
    );
    expect(database.db.select().from(projectTasks).all()).toHaveLength(0);
  });

  it('never replays a creation whose commit was not acknowledged', async () => {
    await asPerson('admin', async () => {
      vi.spyOn(domain, 'recordActivity').mockImplementation(() => {
        throw new Error('Simulated crash after commit');
      });
      await expect(tools.execute('agent', create())).rejects.toThrow(
        'Simulated',
      );
      expect(database.db.select().from(projectTasks).all()).toHaveLength(1);
      await expect(tools.execute('agent', create())).rejects.toThrow(
        'unconfirmed',
      );
      expect(
        database.db.select().from(projectAgentToolRequests).all(),
      ).toHaveLength(1);
      expect(database.db.select().from(projectTasks).all()).toHaveLength(1);
    });
  });

  it('rechecks the execution lease after asynchronous deliverable directory preparation', async () => {
    let checks = 0;
    await asPerson('admin', async () => {
      await expect(
        tools.execute('agent', create('create_deliverable'), () => {
          if (++checks >= 3) throw new Error('Stopped');
        }),
      ).rejects.toThrow('Stopped');
      expect(deliverables.agentCatalog('p')).toHaveLength(0);
    });
  });
});
