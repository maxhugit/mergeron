/** Real migration chain and SQLite transactions; no model calls or credentials. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  agentMonitors,
  agentMonitorRuns,
  people,
  projects,
  projectAgentThreads,
} from '../database/schema';
import { AgentMonitorStore } from './agent-monitor-store';
import type { CreateAgentMonitor } from './agent-monitor-types';

const NOW = 1_800_000_000_000;
let database: TestDatabase;
let store: AgentMonitorStore;
const definition = (
  overrides: Partial<CreateAgentMonitor> = {},
): CreateAgentMonitor => ({
  requestId: 'request',
  name: 'Watch the PR',
  instructions: 'Read checks; do not merge without human authorization.',
  runAt: NOW,
  intervalMs: 60_000,
  expiresAt: NOW + 86_400_000,
  ...overrides,
});
function seed(db: TestDatabase['db']) {
  db.insert(projects)
    .values([
      {
        id: 'p',
        name: 'Project',
        workspacePath: '/p',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'q',
        name: 'Other',
        workspacePath: '/q',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])
    .run();
  db.insert(people)
    .values([
      {
        id: 'admin',
        reference: 'admin',
        name: 'Administrator',
        role: 'administrator',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'standard',
        reference: 'standard',
        name: 'Person',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])
    .run();
  db.insert(projectAgentThreads)
    .values([
      {
        threadId: 't',
        projectId: 'p',
        workspacePath: '/p',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        threadId: 'other',
        projectId: 'q',
        workspacePath: '/q',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])
    .run();
}
const create = (overrides: Partial<CreateAgentMonitor> = {}) =>
  store.create('p', 't', 'admin', definition(overrides), NOW);
function start(overrides: Partial<CreateAgentMonitor> = {}) {
  const monitor = create(overrides);
  const claim = store.claim('p', monitor.id, NOW)!;
  expect(store.beginDispatch(claim.run.id, NOW)).not.toBeNull();
  expect(store.bind(claim.run.id, 'turn')).toBeDefined();
  return { monitor, run: claim.run };
}
beforeEach(() => {
  database = createTestDatabase();
  seed(database.db);
  store = new AgentMonitorStore(database.db);
});
afterEach(() => database.sqlite.close());

describe('durable agent monitor store', () => {
  it.each(['claimed', 'dispatching', 'running'] as const)(
    'yields %s work to a human without pausing, resetting limits or accepting a late completion',
    (phase) => {
      const monitor = create({ intervalMs: 120_000 });
      const { run } = store.claim('p', monitor.id, NOW)!;
      if (phase !== 'claimed') store.beginDispatch(run.id, NOW);
      if (phase === 'running') store.bind(run.id, 'turn');
      store.yieldToForeground(run.id, NOW + 1_000);
      expect(store.get('p', monitor.id)).toMatchObject({
        status: 'active',
        nextRunAt: NOW + 121_000,
        runCount: phase === 'claimed' ? 0 : 1,
        maxRuns: 20,
        lastReason: 'MONITOR_USER_TAKEOVER',
      });
      expect(store.active()).toEqual([]);
      expect(store.readRun(run.id)).toMatchObject({
        status: 'deferred',
        reason: 'MONITOR_USER_TAKEOVER',
      });
      expect(
        store.finish(run.id, phase === 'running' ? 'turn' : null, {
          success: true,
          result: 'Late answer now belongs to the human conversation.',
          disposition: 'complete',
        }),
      ).toBeNull();
      expect(store.claim('p', monitor.id, NOW + 121_000)).not.toBeNull();
    },
  );

  it('does not turn a human message into an implicit resume or replenish an exhausted budget', () => {
    const { monitor, run } = start();
    store.setPaused('p', monitor.id, true, NOW);
    store.yieldToForeground(run.id, NOW + 1000);
    expect(store.get('p', monitor.id)).toMatchObject({
      status: 'paused',
      nextRunAt: null,
    });
    const limited = start({ requestId: 'limited', maxRuns: 1 });
    store.yieldToForeground(limited.run.id, NOW + 1000);
    expect(store.get('p', limited.monitor.id)).toMatchObject({
      status: 'exhausted',
      runCount: 1,
      nextRunAt: null,
    });
  });

  it('defaults to read-only, persists bounded scheduling and deduplicates retries even after the scheduled time', () => {
    const input = definition();
    const item = create();
    expect(item).toMatchObject({
      status: 'active',
      accessMode: 'readOnly',
      runCount: 0,
      maxRuns: 20,
      maxRunMs: 300_000,
    });
    expect(store.create('p', 't', 'admin', input, NOW + 3_600_000).id).toBe(
      item.id,
    );
    expect(() =>
      store.create(
        'p',
        't',
        'admin',
        { ...input, instructions: 'Different scope' },
        NOW,
      ),
    ).toThrow('MONITOR_REQUEST_CONFLICT');
    expect(store.list('p')).toHaveLength(1);
    expect(store.list('q')).toEqual([]);
    expect(() => store.get('q', item.id)).toThrow('MONITOR_NOT_FOUND');
  });

  it.each([
    { maxRuns: 0 },
    { maxRuns: 101 },
    { intervalMs: 1 },
    { maxRunMs: 1 },
    { expiresAt: NOW },
    { runAt: NOW + 100_000_000 },
    { instructions: '' },
    { requestId: 'invalid id' },
    { expiresAt: NOW + 31 * 86_400_000 },
  ])('rejects invalid limits or schedules %j', (overrides) => {
    expect(() => create(overrides)).toThrow();
    expect(store.list('p')).toHaveLength(0);
  });

  it('requires an active administrator and an explicitly associated thread in the same project', () => {
    expect(() => store.create('p', 't', 'standard', definition(), NOW)).toThrow(
      'MONITOR_OWNER_OR_THREAD_UNAVAILABLE',
    );
    expect(() =>
      store.create('p', 'other', 'admin', definition(), NOW),
    ).toThrow('MONITOR_OWNER_OR_THREAD_UNAVAILABLE');
    database.db
      .update(people)
      .set({ active: false })
      .where(eq(people.id, 'admin'))
      .run();
    expect(() => create()).toThrow('MONITOR_OWNER_OR_THREAD_UNAVAILABLE');
  });

  it('serializes all monitors targeting the same conversation and counts only dispatch attempts', () => {
    const first = create();
    const second = create({ requestId: 'second' });
    const claim = store.claim('p', first.id, NOW)!;
    expect(store.claim('p', first.id, NOW)).toBeNull();
    expect(store.claim('p', second.id, NOW)).toBeNull();
    store.defer(claim.run.id, 'MONITOR_AGENT_BUSY', NOW);
    expect(store.get('p', first.id).runCount).toBe(0);
    const next = store.claim('p', second.id, NOW)!;
    expect(store.beginDispatch(next.run.id, NOW)?.monitor.runCount).toBe(1);
    expect(store.beginDispatch(next.run.id, NOW)).toBeNull();
  });

  it('pauses without cancelling accepted work, disallows deleting an active delivery, and never resumes beyond limits', () => {
    const { monitor, run } = start({ maxRuns: 1 });
    store.setPaused('p', monitor.id, true, NOW);
    expect(store.due(NOW + 60_000)).toEqual([]);
    expect(store.active()).toHaveLength(1);
    expect(() => store.remove('p', monitor.id)).toThrow(
      'MONITOR_ALREADY_RUNNING',
    );
    expect(() => store.setPaused('p', monitor.id, false, NOW)).toThrow();
    store.finish(
      run.id,
      'turn',
      { success: true, result: 'Checks pending' },
      NOW + 1000,
    );
    expect(store.get('p', monitor.id).status).toBe('paused');
    expect(() => store.setPaused('p', monitor.id, false, NOW)).toThrow(
      'MONITOR_LIMIT_REACHED',
    );
    store.remove('p', monitor.id);
    expect(store.list('p')).toEqual([]);
    expect(database.db.select().from(agentMonitorRuns).all()).toEqual([]);
  });

  it('bounds concurrent wakeups globally, including schedules in different projects', () => {
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'third',
        projectId: 'p',
        workspacePath: '/p',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const a = create();
    const b = store.create('q', 'other', 'admin', definition(), NOW);
    const c = store.create('p', 'third', 'admin', definition(), NOW);
    const first = store.claim('p', a.id, NOW)!;
    expect(store.claim('q', b.id, NOW)).not.toBeNull();
    expect(store.claim('p', c.id, NOW)).toBeNull();
    store.defer(first.run.id, 'MONITOR_AGENT_BUSY', NOW);
    expect(store.claim('p', c.id, NOW)).not.toBeNull();
  });

  it('does not mark the last accepted check exhausted while it is still executing', () => {
    const { monitor, run } = start({ intervalMs: null, maxRuns: 1 });
    expect(store.due(NOW + 1000)).toEqual([]);
    expect(store.get('p', monitor.id).status).toBe('active');
    store.finish(run.id, 'turn', { success: true, result: 'Done' }, NOW + 2000);
    expect(store.get('p', monitor.id).status).toBe('completed');
  });

  it('reschedules from completion, not a backlog, and tracks only changed results', () => {
    const { monitor, run } = start();
    expect(
      store.finish(
        run.id,
        'wrong-turn',
        { success: true, result: 'Pending' },
        NOW + 1000,
      ),
    ).toBeNull();
    expect(
      store.finish(
        run.id,
        'turn',
        { success: true, result: 'Pending' },
        NOW + 1000,
      )?.changed,
    ).toBe(true);
    expect(store.get('p', monitor.id).nextRunAt).toBe(NOW + 61_000);
    expect(store.due(NOW + 60_000)).toEqual([]);
    const next = store.claim('p', monitor.id, NOW + 61_000)!;
    store.beginDispatch(next.run.id, NOW + 61_000);
    store.bind(next.run.id, 'next-turn');
    expect(
      store.finish(
        next.run.id,
        'next-turn',
        { success: true, result: 'Pending' },
        NOW + 62_000,
      )?.changed,
    ).toBe(false);
  });

  it.each([
    [{ intervalMs: null }, { success: true, result: 'Done' }, 'completed'],
    [{ maxRuns: 1 }, { success: true, result: 'Still pending' }, 'exhausted'],
    [
      {},
      { success: true, result: 'Goal reached', disposition: 'complete' },
      'completed',
    ],
    [{}, { success: false, result: 'Failure' }, 'needs_attention'],
    [
      {},
      { success: true, result: 'Approval needed', disposition: 'attention' },
      'needs_attention',
    ],
  ] as const)(
    'stops safely after a terminal outcome %j',
    (limits, outcome, status) => {
      const { monitor, run } = start(limits);
      store.finish(run.id, 'turn', outcome, NOW + 1000);
      expect(store.get('p', monitor.id)).toMatchObject({
        status,
        nextRunAt: null,
      });
      expect(store.finish(run.id, 'turn', outcome, NOW + 2000)).toBeNull();
      expect(store.due(NOW + 100_000)).toEqual([]);
    },
  );

  it('recovers only expired pre-send claims automatically; uncertain sends require review', () => {
    const item = create();
    const claim = store.claim('p', item.id, NOW)!;
    store.recover(NOW + 60_000);
    expect(store.history('p', item.id)[0].status).toBe('deferred');
    expect(store.get('p', item.id).runCount).toBe(0);
    expect(store.beginDispatch(claim.run.id, NOW + 60_000)).toBeNull();
    const next = store.claim('p', item.id, NOW + 120_000)!;
    store.beginDispatch(next.run.id, NOW + 120_000);
    store.recover(NOW + 420_000);
    expect(store.history('p', item.id)[0].status).toBe('uncertain');
    expect(store.get('p', item.id)).toMatchObject({
      status: 'needs_attention',
      nextRunAt: null,
      runCount: 1,
    });
    expect(store.bind(next.run.id, 'late-acknowledgement')).toBeUndefined();
    expect(store.due(NOW + 500_000)).toEqual([]);
  });

  it('expires old schedules without dispatch and enforces project capacity', () => {
    const item = create({ expiresAt: NOW + 30_000 });
    expect(store.due(NOW + 30_000)).toEqual([]);
    expect(store.get('p', item.id).status).toBe('expired');
    for (let i = 0; i < 20; i++) create({ requestId: `request-${i}` });
    expect(() => create({ requestId: 'overflow' })).toThrow('MONITOR_CAPACITY');
  });

  it('retains only the latest 100 history entries even when a busy agent defers delivery', () => {
    const item = create();
    for (let i = 0; i < 105; i++) {
      const now = NOW + i * 60_000;
      const claim = store.claim('p', item.id, now)!;
      store.defer(claim.run.id, 'MONITOR_AGENT_BUSY', now);
    }
    expect(store.history('p', item.id)).toHaveLength(100);
    expect(database.db.select().from(agentMonitorRuns).all()).toHaveLength(100);
  });

  it('cascades project/thread/person removal and leaves other projects untouched', () => {
    create();
    const other = store.create('q', 'other', 'admin', definition(), NOW);
    database.db.delete(projects).where(eq(projects.id, 'p')).run();
    expect(store.list('p')).toEqual([]);
    expect(store.get('q', other.id)).toBeDefined();
    database.db.delete(people).where(eq(people.id, 'admin')).run();
    expect(store.list('q')).toEqual([]);
  });

  it('keeps schedules and reservations across a real connection restart without replaying a send', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mergeron-monitors-'));
    const path = join(directory, 'state.sqlite');
    let first: TestDatabase | undefined;
    let second: TestDatabase | undefined;
    try {
      first = createTestDatabase(path);
      seed(first.db);
      const a = new AgentMonitorStore(first.db);
      const item = a.create('p', 't', 'admin', definition(), NOW);
      const claim = a.claim('p', item.id, NOW)!;
      a.beginDispatch(claim.run.id, NOW);
      first.sqlite.close();
      first = undefined;
      second = createTestDatabase(path);
      const b = new AgentMonitorStore(second.db);
      expect(b.active()[0].id).toBe(claim.run.id);
      expect(b.claim('p', item.id, NOW + 1000)).toBeNull();
      b.recover(NOW + 300_000);
      expect(b.get('p', item.id).status).toBe('needs_attention');
      expect(b.due(NOW + 400_000)).toEqual([]);
    } finally {
      first?.sqlite.close();
      second?.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enforces reservation uniqueness and limits in SQLite itself', () => {
    const item = create();
    const claim = store.claim('p', item.id, NOW)!;
    expect(() =>
      database.db
        .insert(agentMonitorRuns)
        .values({ ...claim.run, id: 'duplicate' })
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      database.db
        .update(agentMonitors)
        .set({ maxRuns: 1000 })
        .where(eq(agentMonitors.id, item.id))
        .run(),
    ).toThrow(/CHECK/);
  });
});
