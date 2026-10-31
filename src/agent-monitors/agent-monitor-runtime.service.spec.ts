/** Native transport is mocked: these tests never call a model or external service. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { IdentityService } from '../auth/identity.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { CodexService } from '../codex/codex.service';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { people, projects, projectAgentThreads } from '../database/schema';
import { InternalMcpService } from '../internal-mcp/internal-mcp.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import {
  ThreadsService,
  type BackgroundTurnGuard,
} from '../threads/threads.service';
import { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import { ThreadSettingsObserverService } from '../threads/thread-settings-observer.service';
import { AgentMonitorRuntime } from './agent-monitor-runtime.service';
import { AgentMonitorStore } from './agent-monitor-store';
import { PushService } from '../push/push.service';

const NOW = 1_800_000_000_000;
let database: TestDatabase;
let store: AgentMonitorStore;
let runtime: AgentMonitorRuntime;
let foreground: (threadId: string) => void;
let lifecycle: () => void;
let notify: (note: ServerNotification) => void;
let busy: boolean;
let sequence: number;
const manager = {
  getClient: vi.fn(),
  addListener:
    vi.fn<
      (event: string, listener: (note: ServerNotification) => void) => void
    >(),
  addLifecycleListener: vi.fn<(listener: () => void) => () => void>(),
};
const codex = { request: vi.fn() };
const pending = { listPending: vi.fn() };
const settings = { readSecurityPolicy: vi.fn() };
const mcp = { revoke: vi.fn() };
const push = { enqueue: vi.fn<PushService['enqueue']>() };
const threads = {
  readThread: vi.fn(),
  resumeThread: vi.fn(),
  startTurn:
    vi.fn<
      (
        params: v2.TurnStartParams,
        guard: BackgroundTurnGuard,
      ) => Promise<{ turn: { id: string } }>
    >(),
  onForegroundInput:
    vi.fn<(listener: (id: string) => boolean | void) => () => void>(),
};
const emit = (method: string, params: unknown) =>
  notify({ method, params } as ServerNotification);
const create = (overrides = {}) =>
  store.create('p', 't', 'admin', {
    requestId: 'request',
    name: 'Watch checks',
    instructions: 'Read checks only.',
    runAt: Date.now(),
    intervalMs: 60_000,
    expiresAt: NOW + 86_400_000,
    ...overrides,
  });
const current = () => store.active()[0];
const complete = (turnId = current().turnId!, status = 'completed') =>
  emit('turn/completed', {
    threadId: 't',
    turn: { id: turnId, status },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const object of [manager, codex, pending, settings, mcp, threads, push])
    for (const mock of Object.values(object)) mock.mockReset();
  database = createTestDatabase();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Project',
      workspacePath: '/p',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  database.db
    .insert(people)
    .values({
      id: 'admin',
      reference: 'admin',
      name: 'Admin',
      role: 'administrator',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values({
      threadId: 't',
      projectId: 'p',
      workspacePath: '/p',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  store = new AgentMonitorStore(database.db);
  busy = false;
  sequence = 0;
  manager.getClient.mockReturnValue({});
  manager.addListener.mockImplementation((_event, callback) => {
    notify = callback;
  });
  manager.addLifecycleListener.mockImplementation((callback) => {
    lifecycle = callback;
    return vi.fn();
  });
  threads.onForegroundInput.mockImplementation((callback) => {
    foreground = callback;
    return vi.fn();
  });
  threads.readThread.mockImplementation(() =>
    Promise.resolve({
      thread: {
        status: { type: busy ? 'active' : 'idle' },
        ephemeral: false,
        parentThreadId: null,
      },
    }),
  );
  threads.resumeThread.mockResolvedValue({ mode: 'writable', thread: {} });
  threads.startTurn.mockImplementation(
    async (_params, guard: BackgroundTurnGuard) => {
      await Promise.resolve();
      guard.assertIdle();
      guard.beforeSend();
      return { turn: { id: `turn-${++sequence}` } };
    },
  );
  codex.request.mockResolvedValue({ thread: { status: { type: 'idle' } } });
  pending.listPending.mockReturnValue([]);
  settings.readSecurityPolicy.mockReturnValue({
    observed: true,
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'on-request',
  });
  runtime = new AgentMonitorRuntime(
    database.db,
    store,
    new IdentityService(database.db),
    manager as unknown as CodexProcessManager,
    codex as unknown as CodexService,
    threads as unknown as ThreadsService,
    settings as unknown as ThreadSettingsObserverService,
    { has: () => busy } as ThreadExecutionInventoryService,
    pending as unknown as PendingApprovalsService,
    mcp as unknown as InternalMcpService,
    push as unknown as PushService,
  );
});
afterEach(async () => {
  await runtime.onModuleDestroy();
  database.sqlite.close();
  vi.useRealTimers();
});

describe('persistent authenticated monitor runtime', () => {
  it('captures only observed bounded policies for an agent-created check', () => {
    expect(runtime.accessForSchedule('t')).toBe('readOnly');
    settings.readSecurityPolicy.mockReturnValue({
      observed: true,
      sandboxPolicy: { type: 'workspaceWrite' },
      approvalPolicy: 'on-request',
    });
    expect(runtime.accessForSchedule('t')).toBe('workspaceWrite');
    settings.readSecurityPolicy.mockReturnValue({
      observed: true,
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
    });
    expect(() => runtime.accessForSchedule('t')).toThrow(
      'MONITOR_POLICY_EXCEEDS_GRANT',
    );
    settings.readSecurityPolicy.mockReturnValue({ observed: false });
    expect(() => runtime.accessForSchedule('t')).toThrow(
      'MONITOR_POLICY_UNKNOWN',
    );
  });
  it('notifies only a different summary or terminal/attention outcome without sending private text', async () => {
    const monitor = create();
    for (const [index, disposition] of [
      'continue',
      'continue',
      'complete',
    ].entries()) {
      vi.setSystemTime(NOW + index * 60_000);
      await runtime.tick();
      const run = current();
      store.report(
        run.id,
        run.turnId!,
        'Identical private summary.',
        disposition as 'continue' | 'complete',
      );
      complete();
    }
    expect(store.get('p', monitor.id).status).toBe('completed');
    expect(push.enqueue).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(push.enqueue.mock.calls)).not.toContain(
      'private summary',
    );
    expect(
      push.enqueue.mock.calls.every(
        ([kind, threadId, event]) =>
          kind === 'completed' &&
          threadId === 't' &&
          event.startsWith('monitor:'),
      ),
    ).toBe(true);
  });
  it('reuses the existing thread without overriding its security or opening another conversation', async () => {
    const monitor = create();
    await runtime.tick();
    expect(threads.resumeThread).toHaveBeenCalledWith('t', {
      recordActive: false,
    });
    const params = threads.startTurn.mock.calls[0][0];
    expect(params).toMatchObject({ threadId: 't', turnTrigger: 'automation' });
    for (const field of [
      'sandboxPolicy',
      'approvalPolicy',
      'model',
      'cwd',
      'permissions',
    ])
      expect(params).not.toHaveProperty(field);
    expect(params.input[0].text).toContain(monitor.id);
    expect(current()).toMatchObject({ status: 'running', turnId: 'turn-1' });
    store.report(current().id, 'turn-1', 'Checks pending.', 'continue');
    complete();
    expect(store.get('p', monitor.id)).toMatchObject({
      status: 'active',
      nextRunAt: NOW + 60_000,
      runCount: 1,
    });
  });

  it('waits while a human conversation is busy and continues automatically when idle', async () => {
    const monitor = create();
    busy = true;
    foreground('t');
    await runtime.tick();
    expect(store.history('p', monitor.id)).toEqual([]);
    expect(store.get('p', monitor.id).status).toBe('active');
    expect(threads.startTurn).not.toHaveBeenCalled();
    busy = false;
    await runtime.tick();
    expect(current().status).toBe('running');
  });

  it('keeps monitoring after a human steers an automatic check, without timing out their turn', async () => {
    const monitor = create();
    await runtime.tick();
    const former = current();
    foreground('t');
    expect(mcp.revoke).toHaveBeenCalledWith('t');
    expect(store.get('p', monitor.id)).toMatchObject({
      status: 'active',
      nextRunAt: NOW + 60_000,
      runCount: 1,
    });
    busy = true;
    vi.setSystemTime(NOW + 600_000);
    await runtime.tick();
    complete(former.turnId!);
    expect(codex.request).not.toHaveBeenCalledWith(
      'turn/interrupt',
      expect.anything(),
    );
    expect(store.active()).toEqual([]);
    expect(store.get('p', monitor.id).status).toBe('active');
    busy = false;
    await runtime.tick();
    expect(threads.startTurn).toHaveBeenCalledTimes(2);
    expect(current().turnId).toBe('turn-2');
  });

  it('does not bind a delayed start acknowledgement after foreground ownership transfer', async () => {
    const monitor = create();
    threads.startTurn.mockImplementationOnce(
      async (_params, guard: BackgroundTurnGuard) => {
        await Promise.resolve();
        guard.beforeSend();
        foreground('t');
        return { turn: { id: 'now-human' } };
      },
    );
    await runtime.tick();
    expect(store.active()).toEqual([]);
    expect(store.get('p', monitor.id).status).toBe('active');
    expect(store.history('p', monitor.id)[0]).toMatchObject({
      status: 'deferred',
      turnId: null,
    });
  });

  it('abandons pre-send work if a human starts during preparation without consuming a check', async () => {
    const monitor = create();
    threads.startTurn.mockImplementationOnce(
      async (_params, guard: BackgroundTurnGuard) => {
        await Promise.resolve();
        foreground('t');
        guard.beforeSend();
        return { turn: { id: 'not-admitted' } };
      },
    );
    await runtime.tick();
    expect(store.get('p', monitor.id)).toMatchObject({
      status: 'active',
      runCount: 0,
      nextRunAt: NOW + 60_000,
    });
  });

  it.each(['workspaceWrite', 'dangerFullAccess', 'externalSandbox'])(
    'refuses a %s policy exceeding a read-only grant',
    async (type) => {
      const monitor = create();
      settings.readSecurityPolicy.mockReturnValue({
        observed: true,
        sandboxPolicy: { type },
        approvalPolicy: 'on-request',
      });
      await runtime.tick();
      expect(threads.startTurn).not.toHaveBeenCalled();
      expect(store.get('p', monitor.id)).toMatchObject({
        status: 'needs_attention',
        runCount: 0,
        lastReason: 'MONITOR_POLICY_EXCEEDS_GRANT',
      });
    },
  );

  it('rechecks the originating person immediately before send', async () => {
    const monitor = create();
    threads.startTurn.mockImplementationOnce(
      async (_params, guard: BackgroundTurnGuard) => {
        await Promise.resolve();
        database.db
          .update(people)
          .set({ active: false })
          .where(eq(people.id, 'admin'))
          .run();
        guard.beforeSend();
        return { turn: { id: 'not-admitted' } };
      },
    );
    await runtime.tick();
    expect(store.get('p', monitor.id)).toMatchObject({
      status: 'needs_attention',
      runCount: 0,
    });
    expect(store.active()).toEqual([]);
  });

  it('recognizes a native completion preceding the RPC acknowledgement', async () => {
    const monitor = create();
    threads.startTurn.mockImplementationOnce(
      async (_params, guard: BackgroundTurnGuard) => {
        await Promise.resolve();
        guard.beforeSend();
        emit('turn/started', { threadId: 't', turn: { id: 'early' } });
        emit('item/completed', {
          threadId: 't',
          turnId: 'early',
          item: { type: 'agentMessage', text: 'Objective reached.' },
        });
        store.report(current().id, 'early', 'Objective reached.', 'complete');
        complete('early');
        return { turn: { id: 'early' } };
      },
    );
    await runtime.tick();
    expect(store.get('p', monitor.id)).toMatchObject({
      status: 'completed',
      runCount: 1,
    });
    expect(store.active()).toEqual([]);
    expect(store.history('p', monitor.id)[0].result).toBe('Objective reached.');
  });

  it('does not replay uncertain sends after a native restart, even after idleness is established', async () => {
    const monitor = create();
    await runtime.tick();
    lifecycle();
    expect(store.get('p', monitor.id).status).toBe('needs_attention');
    await runtime.tick();
    expect(store.active()).toEqual([]);
    vi.setSystemTime(NOW + 120_000);
    await runtime.tick();
    expect(threads.startTurn).toHaveBeenCalledTimes(1);
  });

  it('interrupts only its exact timed-out turn once and never approves a request', async () => {
    const monitor = create({ maxRunMs: 30_000 });
    await runtime.tick();
    vi.setSystemTime(NOW + 30_001);
    await runtime.tick();
    expect(codex.request).toHaveBeenCalledTimes(1);
    expect(codex.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 't',
      turnId: 'turn-1',
    });
    vi.setSystemTime(NOW + 40_000);
    await runtime.tick();
    expect(codex.request).toHaveBeenCalledTimes(1);
    expect(store.get('p', monitor.id).status).toBe('needs_attention');
  });

  it('does not interpret human input as a resume for an explicitly paused schedule', async () => {
    const monitor = create();
    await runtime.tick();
    store.setPaused('p', monitor.id, true);
    foreground('t');
    vi.setSystemTime(NOW + 600_000);
    await runtime.tick();
    expect(store.get('p', monitor.id).status).toBe('paused');
    expect(threads.startTurn).toHaveBeenCalledTimes(1);
  });
});
