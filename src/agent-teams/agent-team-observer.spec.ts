import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { projectAgentThreads, projects } from '../database/schema';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamObserver } from './agent-team-observer.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';

let database: TestDatabase, store: AgentTeamStore, observer: AgentTeamObserver;
beforeEach(() => {
  database = createTestDatabase();
  store = new AgentTeamStore(database.db);
  database.db
    .insert(projects)
    .values([
      {
        id: 'p',
        name: 'Project',
        workspacePath: '/p',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'q',
        name: 'Other',
        workspacePath: '/q',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  database.db
    .insert(projectAgentThreads)
    .values([
      {
        projectId: 'p',
        threadId: 'parent',
        workspacePath: '/p',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        projectId: 'q',
        threadId: 'private',
        workspacePath: '/q',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  observer = new AgentTeamObserver(store, {
    addListener() {},
    addLifecycleListener() {},
  } as unknown as CodexProcessManager);
});
afterEach(() => database.sqlite.close());
const spawn = (child = 'child', extra: Record<string, unknown> = {}) => ({
  method: 'item/completed',
  params: {
    threadId: 'parent',
    turnId: 'turn',
    item: {
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: [child],
      prompt: 'Read documents',
      agentsStates: {},
      ...extra,
    },
  },
});
describe('native team observation', () => {
  it('groups native siblings by coordinator turn and tolerates duplicate notifications', () => {
    observer.observe(spawn());
    observer.observe(spawn());
    observer.observe(spawn('second'));
    const teams = store.list('p', 'parent');
    expect(teams).toHaveLength(1);
    expect(teams[0].assignments).toHaveLength(2);
    expect(teams[0].assignments.every((a) => a.status === 'unknown')).toBe(
      true,
    );
  });
  it('does not adopt forks, untrusted senders, failed spawns or another project', () => {
    observer.observe({
      method: 'thread/started',
      params: { thread: { id: 'fork', forkedFromId: 'parent' } },
    });
    observer.observe(spawn('spoof', { senderThreadId: 'private' }));
    observer.observe(spawn('failed', { status: 'failed' }));
    observer.observe(spawn('private'));
    expect(store.list('p', 'parent')).toEqual([]);
  });
  it('retains the final answer when completion carries no message', () => {
    observer.observe(spawn());
    observer.observe({
      method: 'item/completed',
      params: {
        threadId: 'child',
        item: { type: 'agentMessage', phase: 'final_answer', text: 'Findings' },
      },
    });
    observer.observe({
      method: 'turn/completed',
      params: { threadId: 'child', turn: { status: 'completed' } },
    });
    observer.observe({ method: 'turn/started', params: { threadId: 'child' } });
    expect(store.list('p', 'parent')[0].assignments[0]).toMatchObject({
      status: 'completed',
      result: 'Findings',
    });
  });
  it('never lets another coordinator update the child', () => {
    observer.observe(spawn());
    observer.observe({
      method: 'item/completed',
      params: {
        threadId: 'private',
        item: {
          type: 'collabAgentToolCall',
          senderThreadId: 'private',
          agentsStates: {
            child: { status: 'completed', message: 'Foreign result' },
          },
        },
      },
    });
    expect(store.list('p', 'parent')[0].assignments[0]).toMatchObject({
      status: 'unknown',
      result: null,
    });
  });
  it('marks running children uncertain after restart without launching anything', () => {
    observer.observe(spawn());
    observer.observe({ method: 'turn/started', params: { threadId: 'child' } });
    observer.onModuleInit();
    expect(store.list('p', 'parent')[0].assignments[0].status).toBe('unknown');
  });
});
