/** Regression cases from the cross-manager audit. Synthetic data only; no native CLI calls. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Subject } from 'rxjs';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectWorkspaces,
  projectResources,
  projectTaskStatuses,
  projectTasks,
  projectAgentThreads,
  projectTaskLaunches,
} from '../database/schema';
import { IdentityService } from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import { FilesService } from '../files/files.service';
import type { SettingsService } from '../settings/settings.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { ProjectAgentToolsService } from '../project-knowledge/project-agent-tools.service';
import type { ModuleRef } from '@nestjs/core';
import { ProjectsService } from './projects.service';
import { ProjectTaskRuntimeService } from './project-task-runtime.service';
import { TaskAgentLaunchService } from './task-agent-launch.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ThreadMetadataService } from '../threads/thread-metadata.service';
import type { ThreadsService } from '../threads/threads.service';

let database: TestDatabase,
  root: string,
  domain: ProjectsService,
  deliverables: DeliverablesService,
  identities: IdentityService;
const deletion = { previewDelete: vi.fn(), deleteThread: vi.fn() };
const startThread = vi.fn(),
  startTurn = vi.fn();
const asAdmin = <T>(fn: () => T) =>
  accessContext.run(
    { identity: identities.resolvePerson('admin'), identities },
    fn,
  );
const task = (id: string) =>
  database.db.select().from(projectTasks).where(eq(projectTasks.id, id)).get()!;
const parent = () =>
  domain.createTask('p', 'tasks', { title: 'Main', workspacePath: root });
const child = (parentTaskId: string) =>
  domain.createTask('p', 'tasks', {
    title: 'Work',
    parentTaskId,
    executionMode: 'agent',
  });
beforeEach(async () => {
  vi.resetAllMocks();
  database = createTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'work-consistency-'));
  await mkdir(path.join(root, '.mergeron'));
  const now = Date.now();
  database.db
    .insert(people)
    .values({
      id: 'admin',
      reference: 'admin',
      name: 'Admin',
      role: 'administrator',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projects)
    .values([
      {
        id: 'p',
        name: 'Project',
        workspaceLayoutVersion: 1,
        workspacePath: root,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'other',
        name: 'Other',
        workspacePath: root + '/other',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
  database.db
    .insert(projectWorkspaces)
    .values({
      id: 'primary',
      projectId: 'p',
      name: 'Main',
      path: root,
      primary: true,
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
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'deliverables',
        projectId: 'p',
        type: 'deliverable_board',
        name: 'Deliverables',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
  database.db
    .insert(projectTaskStatuses)
    .values({
      id: 'todo',
      resourceId: 'tasks',
      name: 'To do',
      kind: 'unassigned',
      position: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values([
      {
        threadId: 'agent',
        projectId: 'p',
        workspacePath: root,
        createdAt: now,
        updatedAt: now,
      },
      {
        threadId: 'foreign',
        projectId: 'other',
        workspacePath: root + '/other',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
  identities = new IdentityService(database.db);
  const files = new FilesService(
    {
      getStringSetting: (key: string) =>
        key === SECURITY_SETTING_KEYS.workspaceRoots ? root : '',
      getSetting: () => ({ value: '' }),
      onChange: () => () => {},
    } as unknown as SettingsService,
    database.db,
  );
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
    deletion as never,
    null as never,
    null as never,
    database.db,
  );
});
afterEach(async () => {
  database.sqlite.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('preserves the agent, its binding and evidence on task validation and deletion', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    await domain.updateTask('p', 'tasks', sub.id, {
      linkedThreadId: 'agent',
      executionMode: 'agent',
      agentState: 'review',
    });
    const completed = await domain.updateTask('p', 'tasks', sub.id, {
      agentState: 'validated',
      subtaskStatus: 'done',
    });
    expect(completed.linkedThreadId).toBe('agent');
    expect(completed.progress).toBe(100);
    const removed = await domain.deleteTask('p', 'tasks', main.id);
    expect(removed.preservedAgentIds).toEqual(['agent']);
    expect(
      database.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, 'agent'))
        .get(),
    ).toBeDefined();
    expect(deletion.previewDelete).not.toHaveBeenCalled();
    expect(deletion.deleteThread).not.toHaveBeenCalled();
  }));
it('enforces the same primary-task uniqueness through create, generic edit and association', async () =>
  asAdmin(async () => {
    const main = parent();
    const a = await deliverables.create('p', 'deliverables', {
      title: 'A',
      primaryTaskId: main.id,
    });
    const b = await deliverables.create('p', 'deliverables', { title: 'B' });
    expect(() =>
      deliverables.update('p', 'deliverables', b.id, {
        version: b.version,
        primaryTaskId: main.id,
      }),
    ).toThrow('already has');
    await expect(
      deliverables.create('p', 'deliverables', {
        title: 'C',
        primaryTaskId: main.id,
      }),
    ).rejects.toThrow('already has');
    expect(deliverables.get('p', 'deliverables', a.id).primaryTaskId).toBe(
      main.id,
    );
  }));
it('rejects missing, foreign and already assigned agents', async () =>
  asAdmin(async () => {
    const main = parent(),
      a = child(main.id),
      b = child(main.id);
    await domain.updateTask('p', 'tasks', a.id, { linkedThreadId: 'agent' });
    for (const linkedThreadId of ['missing', 'foreign', 'agent'])
      await expect(
        domain.updateTask('p', 'tasks', b.id, { linkedThreadId }),
      ).rejects.toThrow();
    expect(task(b.id).linkedThreadId).toBeNull();
  }));
it('blocks a third task level and stale revisions without overwriting data', async () =>
  asAdmin(async () => {
    const a = parent(),
      sub = child(a.id),
      b = parent();
    await expect(
      domain.updateTask('p', 'tasks', a.id, { parentTaskId: b.id }),
    ).rejects.toThrow('with subtasks');
    const changed = await domain.updateTask('p', 'tasks', sub.id, {
      expectedUpdatedAt: sub.updatedAt,
      title: 'Person A',
    });
    expect(changed.updatedAt).toBeGreaterThan(sub.updatedAt);
    await expect(
      domain.updateTask('p', 'tasks', sub.id, {
        expectedUpdatedAt: sub.updatedAt,
        title: 'Stale person B',
      }),
    ).rejects.toThrow('changed');
    expect(task(sub.id).title).toBe('Person A');
  }));
it('exposes the same task-derived deliverable in the board and MCP context', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    await domain.updateTask('p', 'tasks', sub.id, { linkedThreadId: 'agent' });
    const d = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: main.id,
    });
    expect(
      deliverables.board('p', 'deliverables').deliverables[0].linkedAgentIds,
    ).toEqual(['agent']);
    const tools = new ProjectAgentToolsService(database.db, deliverables, {
      get: () => {
        throw Error('No preview configured');
      },
    } as unknown as ModuleRef);
    const text = await tools.context('agent');
    const snapshot = JSON.parse(
      text!.split('\n').find((line) => line.startsWith('{'))!,
    ) as { linkedDeliverables: Array<{ id: string }> };
    expect(snapshot.linkedDeliverables.map((item) => item.id)).toEqual([d.id]);
  }));
it('tracks ready, running, waiting, failure and review without opening a task manager, and never reopens validated work', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    await domain.updateTask('p', 'tasks', sub.id, {
      linkedThreadId: 'agent',
      agentState: 'ready',
    });
    const runtime = new ProjectTaskRuntimeService(
      database.db,
      new EventEmitter() as unknown as CodexProcessManager,
      {} as ThreadMetadataService,
    );
    runtime.status('agent', { type: 'idle' });
    expect(task(sub.id).agentState).toBe('ready');
    runtime.status('agent', { type: 'active', activeFlags: [] });
    expect(task(sub.id).agentState).toBe('running');
    runtime.status('agent', {
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    });
    expect(task(sub.id).agentState).toBe('waiting');
    runtime.status('agent', { type: 'notLoaded' });
    expect(task(sub.id).agentState).toBe('waiting');
    runtime.completed('agent', true);
    expect(task(sub.id).agentState).toBe('error');
    runtime.status('agent', { type: 'active', activeFlags: [] });
    runtime.completed('agent', false);
    expect(task(sub.id).agentState).toBe('review');
    await domain.updateTask('p', 'tasks', sub.id, {
      agentState: 'validated',
      subtaskStatus: 'done',
    });
    runtime.status('agent', { type: 'active', activeFlags: [] });
    expect(task(sub.id).agentState).toBe('validated');
  }));
it('keeps one recoverable agent after an uncertain first turn and never replays it on retry', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    startThread.mockResolvedValue({ thread: { id: 'new-agent' } });
    startTurn.mockRejectedValue(Error('Response lost'));
    vi.spyOn(domain, 'associateAgent').mockImplementation(
      (_project, threadId) => {
        database.db
          .insert(projectAgentThreads)
          .values({
            threadId,
            projectId: 'p',
            workspacePath: root,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
        return Promise.resolve();
      },
    );
    const launch = new TaskAgentLaunchService(database.db, domain, {
      startThread,
      startTurn,
    } as unknown as ThreadsService);
    const request = { requestId: 'stable-1', expectedUpdatedAt: sub.updatedAt };
    const first = await launch.launch('p', 'tasks', sub.id, request);
    expect(first.state).toBe('needs_attention');
    expect(first.threadId).toBe('new-agent');
    const again = await launch.launch('p', 'tasks', sub.id, request);
    expect(again.threadId).toBe('new-agent');
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(task(sub.id).linkedThreadId).toBe('new-agent');
  }));
it('blocks another allocation after an unknown native creation outcome', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    startThread.mockRejectedValue(Error('RPC disconnected'));
    const launch = new TaskAgentLaunchService(database.db, domain, {
      startThread,
      startTurn,
    } as unknown as ThreadsService);
    for (const requestId of ['one', 'one', 'two'])
      await expect(
        launch.launch('p', 'tasks', sub.id, {
          requestId,
          expectedUpdatedAt: sub.updatedAt,
        }),
      ).rejects.toThrow('UNCONFIRMED');
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
    expect(database.db.select().from(projectTaskLaunches).get()!.state).toBe(
      'needs_attention',
    );
  }));

it('reconciles after restart, tolerates unavailable metadata, and follows live events until destruction', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    await domain.updateTask('p', 'tasks', sub.id, { linkedThreadId: 'agent' });
    const manager = new EventEmitter();
    const changes = new Subject<void>();
    const read = vi
      .fn()
      .mockRejectedValueOnce(Error('Unavailable'))
      .mockResolvedValue({
        entries: [
          {
            thread: {
              id: 'agent',
              status: { type: 'active', activeFlags: [] },
            },
          },
        ],
      });
    const runtime = new ProjectTaskRuntimeService(
      database.db,
      manager as unknown as CodexProcessManager,
      { changes, read } as unknown as ThreadMetadataService,
    );
    runtime.onModuleInit();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(task(sub.id).agentState).toBe('ready');
    changes.next();
    await vi.waitFor(() => expect(task(sub.id).agentState).toBe('running'));
    manager.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'agent',
        turn: { status: 'failed' },
      },
    });
    expect(task(sub.id).agentState).toBe('error');
    // Discovery omission and temporary unloading are not deletion evidence.
    read.mockResolvedValue({ entries: [] });
    changes.next();
    await runtime.reconcile();
    expect(task(sub.id).linkedThreadId).toBe('agent');
    runtime.onModuleDestroy();
    manager.emit('notification', {
      method: 'thread/deleted',
      params: { threadId: 'agent' },
    });
    expect(task(sub.id).linkedThreadId).toBe('agent');
  }));

it('cleans links and durable receipts only on explicit native deletion', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    await domain.updateTask('p', 'tasks', sub.id, { linkedThreadId: 'agent' });
    const d = await deliverables.create('p', 'deliverables', {
      title: 'Evidence',
      primaryTaskId: sub.parentTaskId,
    });
    database.db
      .insert(projectTaskLaunches)
      .values({
        taskId: sub.id,
        projectId: 'p',
        requestId: 'one',
        ownerId: 'admin',
        threadId: 'agent',
        state: 'submitted',
        updatedAt: Date.now(),
      })
      .run();
    const runtime = new ProjectTaskRuntimeService(
      database.db,
      new EventEmitter() as unknown as CodexProcessManager,
      {} as ThreadMetadataService,
    );
    runtime.deleted('agent');
    expect(task(sub.id)).toMatchObject({
      linkedThreadId: null,
      agentState: 'error',
    });
    expect(database.db.select().from(projectTaskLaunches).all()).toEqual([]);
    expect(
      deliverables
        .board('p', 'deliverables')
        .deliverables.find((x) => x.id === d.id)?.linkedAgentIds,
    ).toEqual([]);
  }));

it('reserves a launch across concurrent callers and reuses its successful receipt after restart', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    let resolve!: (value: unknown) => void;
    startThread.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    startTurn.mockResolvedValue({});
    vi.spyOn(domain, 'associateAgent').mockImplementation(
      (_project, threadId) => {
        database.db
          .insert(projectAgentThreads)
          .values({
            threadId,
            projectId: 'p',
            workspacePath: root,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
        return Promise.resolve();
      },
    );
    const native = { startThread, startTurn } as unknown as ThreadsService;
    const launch = new TaskAgentLaunchService(database.db, domain, native);
    const request = { requestId: 'one', expectedUpdatedAt: sub.updatedAt };
    const first = launch.launch('p', 'tasks', sub.id, request);
    await expect(
      launch.launch('p', 'tasks', sub.id, { ...request, requestId: 'two' }),
    ).rejects.toThrow('UNCONFIRMED');
    resolve({ thread: { id: 'new-agent' } });
    await expect(first).resolves.toMatchObject({ state: 'submitted' });
    const restarted = new TaskAgentLaunchService(database.db, domain, native);
    await expect(
      restarted.launch('p', 'tasks', sub.id, request),
    ).resolves.toMatchObject({ threadId: 'new-agent', resumed: true });
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
    await expect(
      restarted.launch('p', 'deliverables', sub.id, request),
    ).rejects.toThrow();
  }));

it('refuses a stale or unauthorized launch before allocating an agent', async () => {
  const sub = asAdmin(() => child(parent().id));
  const launch = new TaskAgentLaunchService(database.db, domain, {
    startThread,
    startTurn,
  } as unknown as ThreadsService);
  await expect(
    launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    }),
  ).rejects.toThrow('authenticated');
  await asAdmin(async () => {
    await domain.updateTask('p', 'tasks', sub.id, { title: 'Changed' });
    await expect(
      launch.launch('p', 'tasks', sub.id, {
        requestId: 'one',
        expectedUpdatedAt: sub.updatedAt,
      }),
    ).rejects.toThrow('changed');
  });
  expect(startThread).not.toHaveBeenCalled();
});

it('never lets a stale or in-flight discovery overwrite a more recent failed turn', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    await domain.updateTask('p', 'tasks', sub.id, {
      linkedThreadId: 'agent',
      agentState: 'running',
    });
    const manager = new EventEmitter(),
      changes = new Subject<void>();
    let resolve!: (value: unknown) => void;
    const read = vi.fn().mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const runtime = new ProjectTaskRuntimeService(
      database.db,
      manager as unknown as CodexProcessManager,
      { read, changes } as unknown as ThreadMetadataService,
    );
    runtime.onModuleInit();
    manager.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'agent', turn: { status: 'failed' } },
    });
    const active = {
      entries: [
        {
          thread: { id: 'agent', status: { type: 'active', activeFlags: [] } },
        },
      ],
      freshness: { stale: false },
    };
    resolve(active);
    await vi.waitFor(() => expect(task(sub.id).agentState).toBe('error'));
    read.mockResolvedValue({ ...active, freshness: { stale: true } });
    await runtime.reconcile();
    expect(task(sub.id).agentState).toBe('error');
    read.mockResolvedValue({
      entries: [{ thread: { id: 'agent', status: { type: 'idle' } } }],
      freshness: { stale: false },
    });
    await runtime.reconcile();
    expect(task(sub.id).agentState).toBe('error');
    runtime.onModuleDestroy();
  }));
