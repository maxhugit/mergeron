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
  projectAgentLaunches,
  projectDeliverables,
  projectParticipants,
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
import { ProjectAgentLaunchService } from './project-agent-launch.service';
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
    const launch = new ProjectAgentLaunchService(
      database.db,
      domain,
      {
        startThread,
        startTurn,
      } as unknown as ThreadsService,
      deliverables,
      {} as ThreadMetadataService,
    );
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
    const launch = new ProjectAgentLaunchService(
      database.db,
      domain,
      {
        startThread,
        startTurn,
      } as unknown as ThreadsService,
      deliverables,
      {} as ThreadMetadataService,
    );
    for (const requestId of ['one', 'one', 'two'])
      await expect(
        launch.launch('p', 'tasks', sub.id, {
          requestId,
          expectedUpdatedAt: sub.updatedAt,
        }),
      ).resolves.toMatchObject({ state: 'needs_attention', threadId: null });
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
    expect(database.db.select().from(projectAgentLaunches).get()!.state).toBe(
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
      .insert(projectAgentLaunches)
      .values({
        id: 'receipt',
        taskId: sub.id,
        scope: `task:${sub.id}`,
        targetKey: `task:${sub.id}`,
        projectId: 'p',
        resourceId: 'tasks',
        ownerId: 'admin',
        requestId: 'one',
        context: {
          kind: 'task',
          targetId: sub.id,
          targetRevision: sub.updatedAt,
          cwd: root,
          title: sub.title,
          taskId: sub.id,
          createdSubtask: false,
          existing: false,
        },
        threadId: 'agent',
        phase: 'submitted',
        state: 'submitted',
        createdAt: Date.now(),
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
    expect(database.db.select().from(projectAgentLaunches).all()).toEqual([]);
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
    const launch = new ProjectAgentLaunchService(
      database.db,
      domain,
      native,
      deliverables,
      {} as ThreadMetadataService,
    );
    const request = { requestId: 'one', expectedUpdatedAt: sub.updatedAt };
    const first = launch.launch('p', 'tasks', sub.id, request);
    await expect(
      launch.launch('p', 'tasks', sub.id, { ...request, requestId: 'two' }),
    ).resolves.toMatchObject({ state: 'pending', threadId: null });
    resolve({ thread: { id: 'new-agent' } });
    await expect(first).resolves.toMatchObject({ state: 'submitted' });
    const restarted = new ProjectAgentLaunchService(
      database.db,
      domain,
      native,
      deliverables,
      {} as ThreadMetadataService,
    );
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
  const launch = new ProjectAgentLaunchService(
    database.db,
    domain,
    {
      startThread,
      startTurn,
    } as unknown as ThreadsService,
    deliverables,
    {} as ThreadMetadataService,
  );
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

function recoveryService(
  entries: Array<{
    archived: boolean;
    thread: {
      id: string;
      cwd: string;
      status: { type: string };
      name?: string;
    };
  }> = [],
) {
  const read = vi
    .fn()
    .mockResolvedValue({ entries, freshness: { stale: false } });
  const gate = {
    mutate: vi.fn((operation: () => Promise<void>) => operation()),
  };
  const native = {
    startThread,
    startTurn,
    rememberInitialThreadCwd: vi.fn(),
    setThreadName: vi.fn().mockResolvedValue(undefined),
  };
  return {
    launch: new ProjectAgentLaunchService(
      database.db,
      domain,
      native as unknown as ThreadsService,
      deliverables,
      { read } as unknown as ThreadMetadataService,
      gate as never,
    ),
    read,
    native,
    gate,
  };
}
it.each([false, true])(
  'creates and reuses one direct deliverable agent, with primary task present=%s',
  async (primary) =>
    asAdmin(async () => {
      const item = await deliverables.create('p', 'deliverables', {
        title: 'Output',
        ...(primary ? { primaryTaskId: parent().id } : {}),
      });
      const before = database.db.select().from(projectTasks).all().length;
      const { launch } = recoveryService();
      startThread.mockResolvedValue({ thread: { id: 'delivery-agent' } });
      const input = { version: item.version, requestId: 'one' };
      const first = await launch.deliverable(
        'p',
        'deliverables',
        item.id,
        input,
      );
      expect(first).toMatchObject({
        state: 'ready',
        taskId: null,
        createdSubtask: false,
        threadId: 'delivery-agent',
      });
      expect(
        (await launch.deliverable('p', 'deliverables', item.id, input)).id,
      ).toBe(first.id);
      expect(database.db.select().from(projectTasks).all()).toHaveLength(
        before,
      );
      expect(startThread).toHaveBeenCalledTimes(1);
      expect(startTurn).not.toHaveBeenCalled();
      expect(
        deliverables.get('p', 'deliverables', item.id).conversations,
      ).toContainEqual({ type: 'agent', id: 'delivery-agent' });
    }),
);
it('reserves a deliverable and its requested subtask before native allocation, including concurrent retries and target edits', async () =>
  asAdmin(async () => {
    const item = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: parent().id,
    });
    let finish!: (value: unknown) => void;
    startThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { launch, read } = recoveryService();
    const input = {
      version: item.version,
      requestId: 'one',
      subtaskTitle: 'Produce',
    };
    const first = launch.deliverable('p', 'deliverables', item.id, input);
    const second = await launch.deliverable('p', 'deliverables', item.id, {
      ...input,
      requestId: 'two',
    });
    expect(second).toMatchObject({ state: 'pending', createdSubtask: true });
    expect(
      database.db
        .select()
        .from(projectTasks)
        .all()
        .filter((task) => task.parentTaskId),
    ).toHaveLength(1);
    const changed = deliverables.update('p', 'deliverables', item.id, {
      version: item.version,
      description: 'Edited during creation',
    });
    const third = await launch.deliverable('p', 'deliverables', item.id, {
      ...input,
      version: changed.version,
      requestId: 'three',
    });
    expect(third.id).toBe(second.id);
    finish({ thread: { id: 'delivery-agent' } });
    expect(await first).toMatchObject({
      state: 'needs_attention',
      threadId: 'delivery-agent',
    });
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(
      database.db
        .select()
        .from(projectTasks)
        .all()
        .filter((task) => task.parentTaskId),
    ).toHaveLength(1);
    read.mockResolvedValue({
      entries: [
        {
          archived: false,
          thread: {
            id: 'delivery-agent',
            cwd: deliverables.agentWorkspace(
              'p',
              'deliverables',
              item.id,
              changed.version,
            ),
            status: { type: 'idle' },
          },
        },
      ],
      freshness: { stale: false },
    });
    const status = await launch.status(
      'p',
      'deliverables',
      'deliverable',
      item.id,
    );
    // Resume only associates; even this confirmed user action never starts a turn.
    const receipt = status.launch!;
    const resumed = await launch.recover('p', 'deliverables', receipt.id, {
      action: 'resume',
      expectedUpdatedAt: receipt.revision,
      targetRevision: changed.version,
    });
    expect(resumed.state).toBe('confirmed');
    expect(startTurn).not.toHaveBeenCalled();
  }));
it('requires a main task before creating a deliverable execution subtask', async () =>
  asAdmin(async () => {
    const item = await deliverables.create('p', 'deliverables', {
      title: 'No primary task',
    });
    const { launch } = recoveryService();
    await expect(
      launch.deliverable('p', 'deliverables', item.id, {
        version: item.version,
        requestId: 'one',
        subtaskTitle: 'Work',
      }),
    ).rejects.toThrow('main task');
    expect(database.db.select().from(projectTasks).all()).toHaveLength(0);
    expect(startThread).not.toHaveBeenCalled();
  }));
it('associates an existing deliverable agent without native creation or dispatch', async () =>
  asAdmin(async () => {
    const item = await deliverables.create('p', 'deliverables', {
      title: 'Existing agent',
    });
    const cwd = deliverables.agentWorkspace(
      'p',
      'deliverables',
      item.id,
      item.version,
    );
    const { launch } = recoveryService([
      {
        archived: false,
        thread: { id: 'agent', cwd, status: { type: 'idle' } },
      },
    ]);
    const result = await launch.deliverable('p', 'deliverables', item.id, {
      version: item.version,
      requestId: 'one',
      existingThreadId: 'agent',
    });
    expect(result).toMatchObject({ state: 'ready', threadId: 'agent' });
    expect(startThread).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  }));
it('recovers an unknown native creation by explicitly selecting an existing eligible agent without replay', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    startThread.mockRejectedValue(Error('Response lost'));
    const { launch } = recoveryService([
      {
        archived: false,
        thread: { id: 'agent', cwd: root, status: { type: 'idle' } },
      },
    ]);
    const result = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    });
    const status = await launch.status('p', 'tasks', 'task', sub.id);
    expect(status.candidates.map((candidate) => candidate.id)).toEqual([
      'agent',
    ]);
    const body = {
      action: 'attach',
      threadId: 'agent',
      expectedUpdatedAt: status.launch!.revision,
      targetRevision: status.launch!.targetRevision,
    };
    await expect(
      launch.recover('p', 'tasks', result.id, {
        ...body,
        expectedUpdatedAt: body.expectedUpdatedAt - 1,
      }),
    ).rejects.toThrow('changed');
    const recovered = await launch.recover('p', 'tasks', result.id, body);
    expect(recovered).toMatchObject({ state: 'confirmed', threadId: 'agent' });
    expect(task(sub.id).linkedThreadId).toBe('agent');
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
  }));
it('acknowledges a checked uncertain send without starting another turn', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    startThread.mockResolvedValue({ thread: { id: 'agent' } });
    startTurn.mockRejectedValue(Error('Response lost after send'));
    const { launch } = recoveryService();
    const result = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    });
    expect(result).toMatchObject({
      phase: 'dispatching',
      state: 'needs_attention',
    });
    await expect(
      launch.recover('p', 'tasks', result.id, {
        action: 'resume',
        expectedUpdatedAt: result.revision,
      }),
    ).rejects.toThrow('uncertain send');
    const status = await launch.status('p', 'tasks', 'task', sub.id);
    expect(
      await launch.recover('p', 'tasks', result.id, {
        action: 'acknowledge',
        verified: true,
        expectedUpdatedAt: status.launch!.revision,
      }),
    ).toMatchObject({ state: 'confirmed' });
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
  }));
it('refuses stale inventory, busy, archived, foreign and already assigned candidates', async () =>
  asAdmin(async () => {
    const sub = child(parent().id),
      other = child(sub.parentTaskId!);
    await domain.updateTask('p', 'tasks', other.id, {
      linkedThreadId: 'agent',
    });
    startThread.mockRejectedValue(Error('Unknown'));
    const entries = [
      {
        archived: false,
        thread: { id: 'agent', cwd: root, status: { type: 'idle' } },
      },
      {
        archived: false,
        thread: { id: 'foreign', cwd: root, status: { type: 'idle' } },
      },
      {
        archived: false,
        thread: { id: 'active', cwd: root, status: { type: 'active' } },
      },
      {
        archived: true,
        thread: { id: 'archived', cwd: root, status: { type: 'idle' } },
      },
    ];
    const { launch, read } = recoveryService(entries);
    const result = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    });
    const status = await launch.status('p', 'tasks', 'task', sub.id);
    expect(status.candidates).toEqual([]);
    await expect(
      launch.recover('p', 'tasks', result.id, {
        action: 'attach',
        threadId: 'foreign',
        expectedUpdatedAt: status.launch!.revision,
        targetRevision: sub.updatedAt,
      }),
    ).rejects.toThrow('no longer available');
    read.mockResolvedValue({ entries, freshness: { stale: true } });
    expect(await launch.status('p', 'tasks', 'task', sub.id)).toMatchObject({
      inventoryError: true,
      candidates: [],
    });
  }));

it('replays the same request identifier after target versions and later successful launches change', async () =>
  asAdmin(async () => {
    const item = await deliverables.create('p', 'deliverables', {
      title: 'Output',
    });
    const { launch } = recoveryService();
    startThread
      .mockResolvedValueOnce({ thread: { id: 'first' } })
      .mockResolvedValueOnce({ thread: { id: 'second' } });
    const first = await launch.deliverable('p', 'deliverables', item.id, {
      requestId: 'first-request',
      version: item.version,
    });
    const current = deliverables.get('p', 'deliverables', item.id);
    const second = await launch.deliverable('p', 'deliverables', item.id, {
      requestId: 'second-request',
      version: current.version,
    });
    expect(second.threadId).toBe('second');
    const replay = await launch.deliverable('p', 'deliverables', item.id, {
      requestId: 'first-request',
      version: current.version,
    });
    expect(replay.id).toBe(first.id);
    expect(replay.threadId).toBe('first');
    expect(startThread).toHaveBeenCalledTimes(2);
  }));
it('keeps creation busy while the native call is pending and rejects recovery by another identity', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    let finish!: (value: unknown) => void;
    startThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { launch } = recoveryService();
    const running = launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    });
    const pending = await launch.status('p', 'tasks', 'task', sub.id);
    expect(pending.launch).toMatchObject({ state: 'pending', busy: true });
    await expect(
      launch.recover('p', 'tasks', pending.launch!.id, {
        action: 'attach',
        threadId: 'agent',
        expectedUpdatedAt: pending.launch!.revision,
        targetRevision: sub.updatedAt,
      }),
    ).rejects.toThrow('busy');
    database.db
      .insert(people)
      .values({
        id: 'other-admin',
        reference: 'other-admin',
        name: 'Other admin',
        role: 'administrator',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await accessContext.run(
      { identity: identities.resolvePerson('other-admin'), identities },
      async () => {
        await expect(
          launch.recover('p', 'tasks', pending.launch!.id, {
            action: 'acknowledge',
            expectedUpdatedAt: pending.launch!.revision,
          }),
        ).rejects.toThrow('not available');
      },
    );
    finish({ thread: { id: 'agent' } });
    startTurn.mockResolvedValue({});
    await running;
    expect(startThread).toHaveBeenCalledTimes(1);
  }));
it('rejects invalid deliverable selections before allocating or creating an execution subtask', async () =>
  asAdmin(async () => {
    const item = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: parent().id,
    });
    const before = database.db.select().from(projectTasks).all().length;
    const { launch } = recoveryService();
    await expect(
      launch.deliverable('p', 'deliverables', item.id, {
        version: item.version,
        requestId: 'one',
        subtaskId: 'missing',
      }),
    ).rejects.toThrow();
    await expect(
      launch.deliverable('p', 'deliverables', item.id, {
        version: item.version,
        requestId: 'one',
        subtaskId: 'missing',
        subtaskTitle: 'New',
      }),
    ).rejects.toThrow();
    expect(database.db.select().from(projectTasks).all()).toHaveLength(before);
    expect(database.db.select().from(projectAgentLaunches).all()).toHaveLength(
      0,
    );
    expect(startThread).not.toHaveBeenCalled();
  }));

it('shares the same allocation and recovery handle when a task is launched from a deliverable and the task manager concurrently', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    const item = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: main.id,
    });
    let finish!: (value: unknown) => void;
    startThread.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { launch } = recoveryService();
    const pending = launch.deliverable('p', 'deliverables', item.id, {
      version: item.version,
      requestId: 'delivery',
      subtaskId: sub.id,
    });
    const taskAttempt = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'task',
      expectedUpdatedAt: sub.updatedAt,
    });
    expect(taskAttempt).toMatchObject({
      state: 'pending',
      resourceId: 'deliverables',
      taskId: sub.id,
    });
    expect((await launch.status('p', 'tasks', 'task', sub.id)).launch?.id).toBe(
      taskAttempt.id,
    );
    finish({ thread: { id: 'shared-agent' } });
    expect((await pending).threadId).toBe('shared-agent');
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
  }));

it('can close an impossible association only after explicitly verifying a known agent, without deleting it or allocating again', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    startThread.mockResolvedValue({ thread: { id: 'known' } });
    vi.spyOn(domain, 'associateAgent').mockRejectedValue(
      Error('Folder changed'),
    );
    const { launch } = recoveryService();
    const result = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    });
    await expect(
      launch.recover('p', 'tasks', result.id, {
        action: 'keep',
        expectedUpdatedAt: result.revision,
      }),
    ).rejects.toThrow('Verify');
    const status = await launch.status('p', 'tasks', 'task', sub.id);
    expect(
      await launch.recover('p', 'tasks', result.id, {
        action: 'keep',
        verified: true,
        expectedUpdatedAt: status.launch!.revision,
      }),
    ).toMatchObject({ state: 'abandoned', threadId: 'known' });
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
    expect(deletion.deleteThread).not.toHaveBeenCalled();
    expect(
      (await launch.status('p', 'tasks', 'task', sub.id)).launch,
    ).toBeNull();
  }));
it('never closes a creation with no confirmed agent identifier, even after user confirmation', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    startThread.mockRejectedValue(Error('Unknown outcome'));
    const { launch } = recoveryService();
    const result = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    });
    await expect(
      launch.recover('p', 'tasks', result.id, {
        action: 'keep',
        verified: true,
        expectedUpdatedAt: result.revision,
      }),
    ).rejects.toThrow('Verify');
    const again = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'two',
      expectedUpdatedAt: sub.updatedAt,
    });
    expect(again.id).toBe(result.id);
    expect(startThread).toHaveBeenCalledTimes(1);
  }));

it('keeps the existing-agent mutation barrier during recovery and permits retry after that barrier clears', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    startThread.mockRejectedValue(Error('Response lost'));
    const { launch, gate } = recoveryService([
      {
        archived: false,
        thread: { id: 'agent', cwd: root, status: { type: 'idle' } },
      },
    ]);
    const result = await launch.launch('p', 'tasks', sub.id, {
      requestId: 'one',
      expectedUpdatedAt: sub.updatedAt,
    });
    gate.mutate.mockRejectedValueOnce(Error('GIT_BUSY'));
    await expect(
      launch.recover('p', 'tasks', result.id, {
        action: 'attach',
        threadId: 'agent',
        expectedUpdatedAt: result.revision,
        targetRevision: sub.updatedAt,
      }),
    ).rejects.toThrow('GIT_BUSY');
    expect(task(sub.id).linkedThreadId).toBeNull();
    const status = await launch.status('p', 'tasks', 'task', sub.id);
    expect(
      await launch.recover('p', 'tasks', result.id, {
        action: 'resume',
        expectedUpdatedAt: status.launch!.revision,
        targetRevision: status.launch!.targetRevision,
      }),
    ).toMatchObject({ state: 'confirmed', threadId: 'agent' });
    expect(gate.mutate).toHaveBeenCalledTimes(2);
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
  }));

it('repairs a migrated known agent association before allowing confirmation of its uncertain send', async () =>
  asAdmin(async () => {
    const sub = child(parent().id);
    database.db
      .insert(projectAgentLaunches)
      .values({
        id: 'migrated',
        scope: `task:${sub.id}`,
        targetKey: `task:${sub.id}`,
        taskId: sub.id,
        projectId: 'p',
        resourceId: 'tasks',
        ownerId: 'admin',
        requestId: 'old',
        state: 'needs_attention',
        phase: 'legacy',
        threadId: 'agent',
        createdAt: 1,
        updatedAt: 2,
        context: {
          kind: 'task',
          targetId: sub.id,
          targetRevision: sub.updatedAt,
          taskId: sub.id,
          cwd: root,
          title: sub.title,
          createdSubtask: false,
          existing: false,
        },
      })
      .run();
    const { launch } = recoveryService([
      {
        archived: false,
        thread: { id: 'agent', cwd: root, status: { type: 'idle' } },
      },
    ]);
    const initial = await launch.status('p', 'tasks', 'task', sub.id);
    expect(initial.launch).toMatchObject({ associationPending: true });
    await expect(
      launch.recover('p', 'tasks', 'migrated', {
        action: 'acknowledge',
        verified: true,
        expectedUpdatedAt: initial.launch!.revision,
      }),
    ).rejects.toThrow('First finish');
    const before = await launch.status('p', 'tasks', 'task', sub.id);
    expect(
      await launch.recover('p', 'tasks', 'migrated', {
        action: 'resume',
        expectedUpdatedAt: before.launch!.revision,
        targetRevision: before.launch!.targetRevision,
      }),
    ).toMatchObject({ state: 'needs_attention', phase: 'legacy' });
    expect(task(sub.id).linkedThreadId).toBe('agent');
    const after = await launch.status('p', 'tasks', 'task', sub.id);
    expect(after.launch).toMatchObject({ associationPending: false });
    expect(
      await launch.recover('p', 'tasks', 'migrated', {
        action: 'acknowledge',
        verified: true,
        expectedUpdatedAt: after.launch!.revision,
      }),
    ).toMatchObject({ state: 'confirmed' });
    expect(startThread).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  }));

it('uses either a direct folder or a deliverable reference, inherited by subtasks', async () =>
  asAdmin(async () => {
    const output = await deliverables.create('p', 'deliverables', {
      title: 'Output',
    });
    const main = domain.createTask('p', 'tasks', {
      title: 'Produce',
      workReference: {
        type: 'deliverable',
        deliverableId: output.id,
        expectedVersion: output.version,
      },
    });
    const sub = child(main.id);
    const cwd = new ActiveFoldersService(database.db).resolve(
      'deliverable',
      output.id,
    );
    expect(task(main.id).workspacePath).toBeNull();
    expect(task(sub.id).workspacePath).toBeNull();
    const board = await domain.readTaskBoard('p', 'tasks');
    expect(board.tasks.find((t) => t.id === sub.id)).toMatchObject({
      workspacePath: cwd,
      workReference: { type: 'deliverable', deliverableId: output.id },
    });
    expect(new ActiveFoldersService(database.db).resolve('task', sub.id)).toBe(
      cwd,
    );
    expect(() =>
      new ActiveFoldersService(database.db).setFromAbsolutePath(
        'p',
        'task',
        main.id,
        root,
      ),
    ).toThrow('inherited');
    expect(() =>
      new ActiveFoldersService(database.db).setFromAbsolutePath(
        'p',
        'task',
        sub.id,
        root,
      ),
    ).toThrow('inherited');
    await expect(
      domain.updateTask('p', 'tasks', main.id, { workspacePath: root }),
    ).rejects.toThrow('Select a folder reference');
    await domain.updateTask('p', 'tasks', main.id, {
      workReference: { type: 'folder', path: root },
    });
    expect(
      deliverables.get('p', 'deliverables', output.id).primaryTaskId,
    ).toBeNull();
    expect(new ActiveFoldersService(database.db).resolve('task', sub.id)).toBe(
      root,
    );
  }));

it('replaces a direct task folder when a deliverable is linked from its manager', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    const output = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: main.id,
    });
    expect(task(main.id).workspacePath).toBeNull();
    expect(task(sub.id).workspacePath).toBeNull();
    const cwd = new ActiveFoldersService(database.db).resolve(
      'deliverable',
      output.id,
    );
    const { launch } = recoveryService();
    startThread.mockResolvedValue({ thread: { id: 'reference-agent' } });
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
    await launch.launch('p', 'tasks', sub.id, {
      requestId: 'reference',
      expectedUpdatedAt: task(sub.id).updatedAt,
    });
    expect(startThread.mock.calls[0][0]).toMatchObject({ cwd });
    expect(startTurn).toHaveBeenCalledOnce();
  }));

it('rolls back missing, foreign, stale and double-reference selections', async () =>
  asAdmin(async () => {
    const main = parent();
    const output = await deliverables.create('p', 'deliverables', {
      title: 'Output',
    });
    for (const ref of [
      {
        type: 'deliverable' as const,
        deliverableId: 'missing',
        expectedVersion: 1,
      },
      {
        type: 'deliverable' as const,
        deliverableId: output.id,
        expectedVersion: output.version + 1,
      },
    ])
      await expect(
        domain.updateTask('p', 'tasks', main.id, { workReference: ref }),
      ).rejects.toThrow();
    await expect(
      domain.updateTask('p', 'tasks', main.id, {
        workspacePath: root,
        workReference: {
          type: 'deliverable',
          deliverableId: output.id,
          expectedVersion: output.version,
        },
      }),
    ).rejects.toThrow('one task work reference');
    expect(task(main.id).workspacePath).toBe(root);
    expect(
      deliverables.get('p', 'deliverables', output.id).primaryTaskId,
    ).toBeNull();
    const sub = child(main.id);
    await expect(
      domain.updateTask('p', 'tasks', sub.id, {
        workReference: { type: 'folder', path: root },
      }),
    ).rejects.toThrow('inherit');
  }));

it('offers only folder references without a deliverables manager and rejects malformed references', async () =>
  asAdmin(async () => {
    database.db
      .delete(projectResources)
      .where(eq(projectResources.id, 'deliverables'))
      .run();
    const main = domain.createTask('p', 'tasks', {
      title: 'Folder only',
      workReference: { type: 'folder', path: root },
    });
    expect(main.workReference).toMatchObject({ type: 'folder', path: root });
    expect(() =>
      domain.createTask('p', 'tasks', {
        title: 'Invalid',
        workReference: {
          type: 'deliverable',
          deliverableId: 'missing',
          expectedVersion: 1,
        },
      }),
    ).toThrow('from this project');
    await expect(
      domain.updateTask('p', 'tasks', main.id, {
        workReference: { type: 'folder', path: 42 } as never,
      }),
    ).rejects.toThrow('Invalid task work reference');
    expect(database.db.select().from(projectTasks).all()).toHaveLength(1);
    await domain.updateTask('p', 'tasks', main.id, {
      workReference: { type: 'folder', path: null },
    });
    expect(task(main.id).workspacePath).toBeNull();
    expect(
      new ActiveFoldersService(database.db).get('task', main.id),
    ).toBeNull();
  }));

it('rejects a deliverable from another project without moving either reference', async () =>
  asAdmin(async () => {
    const now = Date.now();
    database.db
      .insert(projectResources)
      .values({
        id: 'foreign-deliverables',
        projectId: 'other',
        type: 'deliverable_board',
        name: 'Foreign',
        config: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectDeliverables)
      .values({
        id: 'foreign-output',
        resourceId: 'foreign-deliverables',
        title: 'Foreign',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const main = parent();
    await expect(
      domain.updateTask('p', 'tasks', main.id, {
        workReference: {
          type: 'deliverable',
          deliverableId: 'foreign-output',
          expectedVersion: 1,
        },
      }),
    ).rejects.toThrow('from this project');
    expect(task(main.id).workspacePath).toBe(root);
  }));

it('invalidates open task revisions on a deliverable-side reference change', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    const output = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: main.id,
    });
    const before = task(main.id).updatedAt,
      childBefore = task(sub.id).updatedAt;
    deliverables.update('p', 'deliverables', output.id, {
      version: output.version,
      primaryTaskId: null,
    });
    expect(task(main.id).updatedAt).toBeGreaterThan(before);
    expect(task(sub.id).updatedAt).toBeGreaterThan(childBefore);
    await expect(
      domain.updateTask('p', 'tasks', main.id, {
        expectedUpdatedAt: before,
        title: 'Stale',
      }),
    ).rejects.toThrow('changed');
    expect(
      new ActiveFoldersService(database.db).get('task', sub.id),
    ).toBeNull();
  }));

it('does not expose or replace a restricted deliverable through its task reference', async () => {
  const main = asAdmin(() => parent());
  const output = await asAdmin(() =>
    deliverables.create('p', 'deliverables', {
      title: 'Private output',
      primaryTaskId: main.id,
    }),
  );
  const now = Date.now();
  database.db
    .insert(people)
    .values({
      id: 'reader',
      reference: 'reader',
      name: 'Reader',
      role: 'standard',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'reader', createdAt: now })
    .run();
  database.db
    .update(projectDeliverables)
    .set({ confidentiality: 'restricted', authorizedGroupIds: [] })
    .where(eq(projectDeliverables.id, output.id))
    .run();
  await accessContext.run(
    { identity: identities.resolvePerson('reader'), identities },
    async () => {
      const board = await domain.readTaskBoard('p', 'tasks');
      expect(
        board.tasks.find((item) => item.id === main.id)?.workReference,
      ).toMatchObject({
        type: 'deliverable',
        path: null,
        deliverableId: undefined,
        title: undefined,
      });
      expect(
        new ActiveFoldersService(database.db).get('task', main.id),
      ).toBeNull();
      await expect(
        domain.updateTask('p', 'tasks', main.id, {
          workReference: { type: 'folder', path: root },
        }),
      ).rejects.toThrow('not found');
    },
  );
  expect(
    database.db
      .select()
      .from(projectDeliverables)
      .where(eq(projectDeliverables.id, output.id))
      .get()?.primaryTaskId,
  ).toBe(main.id);
});

it('rolls back an incompatible reference change without deleting the agent or its assignments', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    const output = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: main.id,
      conversations: [{ type: 'agent', id: 'agent' }],
    });
    await domain.updateTask('p', 'tasks', sub.id, { linkedThreadId: 'agent' });
    const before = task(main.id).updatedAt;
    await expect(
      domain.updateTask('p', 'tasks', main.id, {
        expectedUpdatedAt: before,
        workReference: { type: 'folder', path: root },
      }),
    ).rejects.toThrow('incompatible agent assignments');
    expect(task(main.id).updatedAt).toBe(before);
    expect(task(main.id).workspacePath).toBeNull();
    expect(deliverables.get('p', 'deliverables', output.id).primaryTaskId).toBe(
      main.id,
    );
    expect(task(sub.id).linkedThreadId).toBe('agent');
    expect(deletion.deleteThread).not.toHaveBeenCalled();
  }));

it('never falls back to the old task folder when its deliverable reference is missing', async () =>
  asAdmin(async () => {
    const main = parent(),
      sub = child(main.id);
    const output = await deliverables.create('p', 'deliverables', {
      title: 'Output',
      primaryTaskId: main.id,
    });
    new ActiveFoldersService(database.db).removeContext(
      'deliverable',
      output.id,
    );
    const board = await domain.readTaskBoard('p', 'tasks');
    expect(board.tasks.find((t) => t.id === sub.id)?.workspacePath).toBeNull();
    const { launch } = recoveryService();
    await expect(
      launch.launch('p', 'tasks', sub.id, {
        requestId: 'missing-reference',
        expectedUpdatedAt: task(sub.id).updatedAt,
      }),
    ).rejects.toThrow('working folder');
    expect(startThread).not.toHaveBeenCalled();
  }));
