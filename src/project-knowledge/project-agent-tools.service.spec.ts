import { AgentContextService } from './agent-context.service';
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
import { AgentInstructionsService } from '../settings/agent-instructions.service';
import { ProjectKnowledgeService } from './project-knowledge.service';

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

  it('reads only the bound project context, refreshes revisions and refuses scope changes or stale turns', async () => {
    let common = 'Current common policy';
    let shared = 'Current knowledge, decisions and memory revision';
    const knowledge = {
      contextForProject: vi.fn(() => Promise.resolve(shared)),
    };
    const activeFolders = {
      get: vi.fn(() => ({ effectivePath: root + '/deliverable' })),
    };
    const modules = {
      get: (key: unknown) => {
        if (key === AgentContextService)
          return new AgentContextService(
            database.db,
            modules as unknown as ModuleRef,
          );
        if (key === AgentInstructionsService) return { context: () => common };
        if (key === ProjectKnowledgeService) return knowledge;
        if (key === ActiveFoldersService) return activeFolders;
        throw Error('Optional provider unavailable');
      },
    };
    const reader = new ProjectAgentToolsService(
      database.db,
      deliverables,
      modules as unknown as ModuleRef,
    );
    const read = () =>
      asPerson('admin', () => reader.execute('agent', { tool: 'get_context' }));
    const before = database.db
      .select()
      .from(projectAgentToolRequests)
      .all().length;
    const first = (await read()) as {
      context: string;
      revision: string;
      project: { id: string };
    };
    expect(first.project.id).toBe('p');
    expect(first.context).toContain(common);
    expect(first.context).toContain(shared);
    expect(first.context).toContain(root + '/deliverable');
    expect(first.context).not.toContain('Foreign');
    expect(knowledge.contextForProject).toHaveBeenCalledWith('p');
    expect(((await read()) as typeof first).revision).toBe(first.revision);
    common = 'Updated administration policy';
    shared = '';
    const second = (await read()) as typeof first;
    expect(second.context).toContain(common);
    expect(second.context).not.toContain('Current knowledge');
    expect(second.revision).not.toBe(first.revision);
    expect(
      database.db.select().from(projectAgentToolRequests).all(),
    ).toHaveLength(before);
    await expect(
      asPerson('admin', () =>
        reader.execute('agent', { tool: 'get_context', projectId: 'other' }),
      ),
    ).rejects.toThrow('Unknown tool field');
    await expect(
      reader.execute('agent', { tool: 'get_context' }),
    ).rejects.toThrow('authenticated turn');
    const active = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw Error('turn revoked');
      });
    await expect(
      asPerson('admin', () =>
        reader.execute('agent', { tool: 'get_context' }, active),
      ),
    ).rejects.toThrow('turn revoked');
    knowledge.contextForProject.mockImplementationOnce(() => {
      database.db
        .update(projectAgentThreads)
        .set({ projectId: 'other' })
        .where(eq(projectAgentThreads.threadId, 'agent'))
        .run();
      return Promise.resolve('Do not leak the previous project');
    });
    await expect(read()).rejects.toThrow('Project changed');
  });

  it('refreshes context for an existing conversation and uses its binding, never cwd', async () => {
    await asPerson('admin', () => tools.execute('agent', create()));
    const context = await asPerson('admin', () =>
      tools.context('agent', '/unrelated/git'),
    );
    expect(context).toContain('Tests 2');
    expect(context).toContain('Use MCP project_get, project_task_list');
    expect(context).toContain('cached legacy names remain compatible');
    expect(context).not.toContain('Presentation');
    expect(context).toContain('/unrelated/git');
    expect(context).not.toContain('Foreign');
    expect(context).not.toContain('Internal execution');
    database.db
      .update(projects)
      .set({ name: 'Renamed' })
      .where(eq(projects.id, 'p'))
      .run();
    expect(await asPerson('admin', () => tools.context('agent'))).toContain(
      'Renamed',
    );
    expect(await tools.context('unbound')).toBeNull();
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
      const context = (await tools.context('agent'))!;
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
      expect(await tools.context('agent')).not.toContain('Secret roadmap');
      const list = (await tools.execute('agent', {
        tool: 'list_deliverables',
      })) as { total: number };
      expect(list.total).toBe(1);
      await expect(
        tools.execute('agent', { tool: 'get_deliverable', id: secret.id }),
      ).rejects.toThrow('unavailable');
    });
  });

  it.each([12, 501])(
    'batches task reads across %i boards while preserving order, scope and bounded context',
    async (boardCount) => {
      const now = Date.now();
      const ids = Array.from(
        { length: boardCount },
        (_, index) => `board-${String(index).padStart(4, '0')}`,
      );
      database.db
        .insert(projectResources)
        .values(
          ids.map((id) => ({
            id,
            projectId: 'p',
            type: 'task_board',
            name: id,
            config: {},
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
      database.db
        .insert(projectTaskStatuses)
        .values(
          ids.map((id) => ({
            id: `${id}-todo`,
            resourceId: id,
            name: 'To do',
            kind: 'unassigned',
            position: 0,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
      database.db
        .insert(projectTasks)
        .values(
          [...ids, 'internal', 'foreign'].map((resourceId) => ({
            id: `${resourceId}-task`,
            resourceId,
            statusId: `${resourceId}-todo`,
            title: resourceId,
            linkedThreadId: 'agent',
            position: 0,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
      const prepare = vi.spyOn(database.sqlite, 'prepare');
      const taskQueries = () =>
        prepare.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.includes('from "project_tasks"'));
      try {
        await asPerson('admin', async () => {
          const result = (await tools.execute('agent', {
            tool: 'list_tasks',
          })) as {
            items: Array<{ id: string }>;
            total: number;
            nextOffset: number | null;
          };
          expect(result.total).toBe(boardCount);
          expect(result.items.map((item) => item.id)).toEqual(
            ids.slice(0, 50).map((id) => `${id}-task`),
          );
          expect(result.nextOffset).toBe(boardCount > 50 ? 50 : null);
          expect(taskQueries()).toHaveLength(Math.ceil((boardCount + 1) / 500));
          prepare.mockClear();
          const context = await tools.context('agent');
          const snapshot = JSON.parse(context!.split('\n')[2]) as {
            linkedTasks: Array<{ id: string }>;
          };
          expect(snapshot.linkedTasks.map((task) => task.id)).toEqual(
            ids.slice(0, 10).map((id) => `${id}-task`),
          );
          expect(context).not.toContain('internal-task');
          expect(context).not.toContain('foreign-task');
          expect(taskQueries()).toHaveLength(Math.ceil((boardCount + 1) / 500));
          expect(
            taskQueries().every((sql) =>
              /where .*"linked_thread_id" = \?.*limit \?$/.test(sql),
            ),
          ).toBe(true);
        });
      } finally {
        prepare.mockRestore();
      }
    },
  );

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
  const attachInput = (
    id: string,
    expectedVersion: number,
    extra: Record<string, unknown> = {},
  ) => ({
    tool: 'attach_deliverable',
    operation: 'attach_self',
    requestId: 'attach-1',
    resourceId: 'deliverables',
    id,
    expectedVersion,
    userRequest: 'Attach yourself to this deliverable.',
    ...extra,
  });
  const attach = (
    input: Record<string, unknown>,
    writable = true,
    check = () => {},
  ) => tools.execute('agent', input, check, 'turn-1', writable);

  it('attaches the calling agent to its newly created deliverable, audits once and replays safely', async () => {
    await asPerson('admin', async () => {
      const created = (await tools.execute(
        'agent',
        create('create_deliverable'),
      )) as { id: string };
      const item = deliverables.get('p', 'deliverables', created.id);
      const beforeFolder = new ActiveFoldersService(database.db).get(
        'agent',
        'agent',
      );
      const input = attachInput(item.id, item.version);
      const result = await attach(input);
      expect(result).toMatchObject({
        id: item.id,
        threadId: 'agent',
        status: 'attached',
        version: item.version + 1,
        contextEffective: 'next_turn',
      });
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toEqual([{ type: 'agent', id: 'agent' }]);
      expect(
        new ActiveFoldersService(database.db).get('agent', 'agent'),
      ).toEqual(beforeFolder);
      expect(await attach(input)).toEqual(result);
      expect(deliverables.get('p', 'deliverables', item.id).version).toBe(
        item.version + 1,
      );
      expect(
        database.db
          .select()
          .from(projectActivity)
          .all()
          .filter((x) => x.action === 'agent_assigned'),
      ).toHaveLength(1);
      const binding = database.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, 'agent'))
        .get();
      expect(binding?.projectId).toBe('p');
    });
  });
  it('does not duplicate a pre-existing attachment with a new request', async () => {
    await asPerson('admin', async () => {
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Self',
      });
      await attach(attachInput(item.id, item.version));
      const current = deliverables.get('p', 'deliverables', item.id);
      expect(
        await attach(
          attachInput(item.id, current.version, { requestId: 'attach-2' }),
        ),
      ).toMatchObject({ status: 'already_attached', version: current.version });
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toHaveLength(1);
    });
  });
  it('refuses stale versions without a partial assignment or a receipt', async () => {
    await asPerson('admin', async () => {
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Stale',
      });
      await expect(
        attach(attachInput(item.id, item.version + 1)),
      ).rejects.toThrow('Deliverable changed');
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toEqual([]);
      expect(
        database.db.select().from(projectAgentToolRequests).all(),
      ).toHaveLength(0);
    });
  });
  it.each([
    ['threadId', 'other-agent'],
    ['projectId', 'other'],
    ['operation', 'detach'],
  ])('rejects caller-selected identity or operation %s', async (key, value) => {
    await asPerson('admin', async () => {
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Self only',
      });
      await expect(
        attach(attachInput(item.id, item.version, { [key]: value })),
      ).rejects.toThrow();
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toEqual([]);
    });
  });
  it('refuses read-only execution, non-administrators and foreign managers', async () => {
    const item = await asPerson('admin', () =>
      deliverables.create('p', 'deliverables', { title: 'Protected' }),
    );
    await asPerson('admin', async () => {
      await expect(
        attach(attachInput(item.id, item.version), false),
      ).rejects.toThrow('writable');
      await expect(
        attach(attachInput(item.id, item.version, { resourceId: 'foreign' })),
      ).rejects.toThrow('this project');
    });
    await expect(
      asPerson('reader', () => attach(attachInput(item.id, item.version))),
    ).rejects.toThrow();
    expect(
      database.db.select().from(projectAgentToolRequests).all(),
    ).toHaveLength(0);
  });
  it('never replaces an assignment to another deliverable', async () => {
    await asPerson('admin', async () => {
      const first = await deliverables.create('p', 'deliverables', {
        title: 'First',
      });
      const second = await deliverables.create('p', 'deliverables', {
        title: 'Second',
      });
      await attach(attachInput(first.id, first.version));
      await expect(
        attach(
          attachInput(second.id, second.version, { requestId: 'attach-2' }),
        ),
      ).rejects.toThrow();
      expect(
        deliverables.get('p', 'deliverables', first.id).conversations,
      ).toHaveLength(1);
      expect(
        deliverables.get('p', 'deliverables', second.id).conversations,
      ).toEqual([]);
    });
  });
  it('rejects incompatible task assignments instead of changing the task', async () => {
    await asPerson('admin', async () => {
      const task = (await tools.execute('agent', create())) as { id: string };
      database.db
        .update(projectTasks)
        .set({ linkedThreadId: 'agent' })
        .where(eq(projectTasks.id, task.id))
        .run();
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Unrelated task',
      });
      await expect(
        attach(attachInput(item.id, item.version)),
      ).rejects.toThrow();
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toEqual([]);
      expect(
        database.db
          .select()
          .from(projectTasks)
          .where(eq(projectTasks.id, task.id))
          .get()?.linkedThreadId,
      ).toBe('agent');
    });
  });
  it('rolls back the association and reference if the activity log cannot commit', async () => {
    await asPerson('admin', async () => {
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Atomic',
      });
      const before = new ActiveFoldersService(database.db).get(
        'agent',
        'agent',
      );
      vi.spyOn(domain, 'recordActivity').mockImplementation(() => {
        throw new Error('Audit unavailable');
      });
      await expect(attach(attachInput(item.id, item.version))).rejects.toThrow(
        'Audit unavailable',
      );
      expect(deliverables.get('p', 'deliverables', item.id).version).toBe(
        item.version,
      );
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toEqual([]);
      expect(
        new ActiveFoldersService(database.db).get('agent', 'agent'),
      ).toEqual(before);
      expect(
        database.db.select().from(projectAgentToolRequests).all(),
      ).toHaveLength(0);
    });
  });
  it('rechecks the active turn before committing and rejects reuse for another request', async () => {
    await asPerson('admin', async () => {
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Lease',
      });
      let calls = 0;
      await expect(
        attach(attachInput(item.id, item.version), true, () => {
          if (++calls > 1) throw new Error('Stopped');
        }),
      ).rejects.toThrow('Stopped');
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toEqual([]);
      await attach(attachInput(item.id, item.version));
      await expect(
        attach(
          attachInput(item.id, item.version, {
            userRequest: 'A different request',
          }),
        ),
      ).rejects.toThrow('Request id already used');
    });
  });
  it('rolls back an attachment if the turn expires immediately before commit', async () => {
    await asPerson('admin', async () => {
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Final lease check',
      });
      let calls = 0;
      await expect(
        attach(attachInput(item.id, item.version), true, () => {
          if (++calls > 2) throw new Error('Expired at commit');
        }),
      ).rejects.toThrow('Expired at commit');
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toEqual([]);
      expect(deliverables.get('p', 'deliverables', item.id).version).toBe(
        item.version,
      );
      expect(
        database.db.select().from(projectAgentToolRequests).all(),
      ).toHaveLength(0);
      expect(
        database.db
          .select()
          .from(projectActivity)
          .all()
          .filter((x) => x.action === 'agent_assigned'),
      ).toHaveLength(0);
    });
  });
  const currentTask = (id: string) =>
    database.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.id, id))
      .get()!;
  const manage = (
    id: string,
    changes: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    tool: 'manage_task',
    operation: 'update',
    requestId: 'task-change-1',
    resourceId: 'tasks',
    id,
    expectedUpdatedAt: currentTask(id).updatedAt,
    userRequest: 'Update the subtask as requested by the human.',
    changes,
    ...extra,
  });
  const runTask = (
    input: Record<string, unknown>,
    writable = true,
    check = () => {},
  ) => tools.execute('agent', input, check, 'turn-1', writable);
  it('updates progress and completion via domain rules, rolls up the parent and records a replay-safe audit', async () =>
    asPerson('admin', async () => {
      const main = domain.createTask('p', 'tasks', { title: 'Main' });
      const child = domain.createTask('p', 'tasks', {
        title: 'Subtask',
        parentTaskId: main.id,
        estimateMinutes: 60,
      });
      const request = manage(child.id, {
        progress: 100,
        subtaskStatus: 'done',
        description: 'Finished',
      });
      expect(await runTask(request)).toMatchObject({
        status: 'updated',
        replayed: false,
        task: { progress: 100, subtaskStatus: 'done', description: 'Finished' },
      });
      const revision = currentTask(child.id).updatedAt;
      expect(await runTask(request)).toMatchObject({
        replayed: true,
        task: { updatedAt: revision },
      });
      expect(currentTask(child.id).updatedAt).toBe(revision);
      expect(currentTask(main.id).progress).toBe(100);
      expect(
        database.db
          .select()
          .from(projectActivity)
          .all()
          .filter((x) => x.action === 'agent_task_managed'),
      ).toHaveLength(1);
      await expect(
        runTask({ ...request, changes: { progress: 70 } }),
      ).rejects.toThrow('TASK_CONFLICT');
    }));
  it('attaches to multiple subtasks of one main task, never replaces another agent, and detaches only itself', async () =>
    asPerson('admin', async () => {
      const main = domain.createTask('p', 'tasks', { title: 'Main' });
      const first = domain.createTask('p', 'tasks', {
        title: 'A',
        parentTaskId: main.id,
      });
      const second = domain.createTask('p', 'tasks', {
        title: 'B',
        parentTaskId: main.id,
      });
      const foreignMain = domain.createTask('p', 'tasks', {
        title: 'Other main',
      });
      const foreignChild = domain.createTask('p', 'tasks', {
        title: 'C',
        parentTaskId: foreignMain.id,
      });
      const assignment = (id: string, operation = 'attach_self') => {
        const request = manage(
          id,
          {},
          { operation, requestId: operation + '-' + id },
        );
        delete (request as Record<string, unknown>).changes;
        return request;
      };
      expect(await runTask(assignment(first.id))).toMatchObject({
        status: 'attached',
        task: { linkedThreadId: 'agent' },
      });
      expect(await runTask(assignment(second.id))).toMatchObject({
        status: 'attached',
      });
      await expect(runTask(assignment(foreignChild.id))).rejects.toThrow(
        'TASK_CONFLICT',
      );
      await expect(runTask(assignment(main.id))).rejects.toThrow(
        'TASK_INVALID_REQUEST',
      );
      expect(currentTask(foreignChild.id).linkedThreadId).toBeNull();
      expect(await runTask(assignment(first.id, 'detach_self'))).toMatchObject({
        status: 'detached',
      });
      expect(currentTask(second.id).linkedThreadId).toBe('agent');
      expect(currentTask(first.id).linkedThreadId).toBeNull();
    }));
  it('requires an observed revision, refuses derived progress and preserves all data on failure', async () =>
    asPerson('admin', async () => {
      const main = domain.createTask('p', 'tasks', { title: 'Main' });
      const child = domain.createTask('p', 'tasks', {
        title: 'A',
        parentTaskId: main.id,
      });
      const stale = manage(child.id, { progress: 40 });
      await domain.updateTask('p', 'tasks', child.id, {
        title: 'Human changed it',
      });
      await expect(runTask(stale)).rejects.toThrow('TASK_REVISION_CONFLICT');
      await expect(runTask(manage(main.id, { progress: 100 }))).rejects.toThrow(
        'TASK_INVALID_REQUEST',
      );
      await expect(
        runTask(manage(child.id, { statusId: 'tasks-todo' })),
      ).rejects.toThrow('TASK_INVALID_REQUEST');
      expect(currentTask(child.id).title).toBe('Human changed it');
      expect(
        database.db.select().from(projectAgentToolRequests).all(),
      ).toHaveLength(0);
    }));
  it('enforces write authority, current membership, project scope and server-side field validation', async () => {
    const child = domain.createTask('p', 'tasks', { title: 'A' });
    await asPerson('admin', async () => {
      await expect(
        runTask(manage(child.id, { progress: 30 }), false),
      ).rejects.toThrow('writable');
      await expect(
        runTask(manage(child.id, { progress: 30 }, { resourceId: 'foreign' })),
      ).rejects.toThrow('this project');
      for (const changes of [
        { progress: 101 },
        { progress: 1.5 },
        { linkedThreadId: 'other' },
        { agentState: 'validated' },
        {},
      ])
        await expect(runTask(manage(child.id, changes))).rejects.toThrow();
      await expect(
        runTask(manage(child.id, { progress: 30 }, { projectId: 'other' })),
      ).rejects.toThrow();
      await expect(
        runTask(manage(child.id, { progress: 30 }), true, () => {
          throw Error('TURN_REVOKED');
        }),
      ).rejects.toThrow('TURN_REVOKED');
    });
    await expect(
      asPerson('reader', () => runTask(manage(child.id, { progress: 30 }))),
    ).rejects.toThrow();
    expect(currentTask(child.id).progress).toBe(0);
    expect(
      database.db.select().from(projectAgentToolRequests).all(),
    ).toHaveLength(0);
  });
});
