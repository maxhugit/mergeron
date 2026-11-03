import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { projects, projectAgentThreads } from '../database/schema';
import { AgentTeamStore } from './agent-team-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let database: TestDatabase;
let store: AgentTeamStore;
const input = () => ({
  requestId: 'request',
  objective: 'Prepare the dossier',
  assignments: [
    {
      key: 'sources',
      role: 'Sources',
      instructions: 'Read sources',
      dependencies: [],
    },
    {
      key: 'review',
      role: 'Review',
      instructions: 'Review findings',
      dependencies: ['sources'],
    },
  ],
});
beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Project',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values({
      projectId: 'p',
      threadId: 'coordinator',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  store = new AgentTeamStore(database.db);
});
afterEach(() => database.sqlite.close());
describe('durable team foundation', () => {
  it('retains native ownership and results after closing and reopening SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mergeron-team-'));
    const file = join(directory, 'teams.sqlite');
    const first = createTestDatabase(file);
    let reopened: TestDatabase | undefined;
    try {
      first.db
        .insert(projects)
        .values({
          id: 'p',
          name: 'Project',
          workspacePath: '/p',
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      first.db
        .insert(projectAgentThreads)
        .values({
          projectId: 'p',
          threadId: 'coordinator',
          workspacePath: '/p',
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      const initial = new AgentTeamStore(first.db),
        team = initial.create('p', 'coordinator', input());
      initial.bind(
        'p',
        team.id,
        team.assignments[0].id,
        'child',
        'coordinator',
      );
      initial.observe('p', team.id, 'child', 'completed', 'Evidence');
      first.sqlite.close();
      reopened = createTestDatabase(file);
      expect(
        new AgentTeamStore(reopened.db).read('p', team.id).assignments[0],
      ).toMatchObject({
        nativeThreadId: 'child',
        status: 'completed',
        result: 'Evidence',
      });
    } finally {
      if (first.sqlite.open) first.sqlite.close();
      reopened?.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('persists definitions and resolves dependency keys without launching agents', () => {
    const team = store.create('p', 'coordinator', input());
    const restored = new AgentTeamStore(database.db).read('p', team.id);
    expect(restored.assignments[1].dependencies).toEqual([
      restored.assignments[0].id,
    ]);
    expect(
      restored.assignments.every(
        (a) => a.status === 'planned' && !a.nativeThreadId,
      ),
    ).toBe(true);
  });
  it('makes creation idempotent but rejects changed requests', () => {
    const first = store.create('p', 'coordinator', input());
    expect(store.create('p', 'coordinator', input()).id).toBe(first.id);
    expect(() =>
      store.create('p', 'coordinator', { ...input(), objective: 'Changed' }),
    ).toThrow('TEAM_REQUEST_REUSED');
  });
  it('rejects cross-project reads and coordinator assignments', () => {
    const team = store.create('p', 'coordinator', input());
    expect(() => store.read('other', team.id)).toThrow('TEAM_NOT_FOUND');
    expect(() => store.create('other', 'coordinator', input())).toThrow(
      'TEAM_COORDINATOR_NOT_FOUND',
    );
  });
  it('rejects cycles and missing dependencies atomically', () => {
    const bad = input();
    bad.assignments[0].dependencies = ['review'];
    expect(() => store.create('p', 'coordinator', bad)).toThrow(
      'TEAM_DEPENDENCY_CYCLE',
    );
    bad.assignments[0].dependencies = ['absent'];
    expect(() => store.create('p', 'coordinator', bad)).toThrow(
      'TEAM_UNKNOWN_DEPENDENCY',
    );
    expect(store.create('p', 'coordinator', input()).assignments).toHaveLength(
      2,
    );
  });
  it('requires a native parent and does not treat binding as success', () => {
    const team = store.create('p', 'coordinator', input());
    expect(() =>
      store.bind('p', team.id, team.assignments[0].id, 'child', 'fork-origin'),
    ).toThrow('TEAM_INVALID_PARENT');
    store.bind('p', team.id, team.assignments[0].id, 'child', 'coordinator');
    expect(store.read('p', team.id).assignments[0].status).toBe('unknown');
    expect(() =>
      store.bind(
        'p',
        team.id,
        team.assignments[0].id,
        'replacement',
        'coordinator',
      ),
    ).toThrow('TEAM_ALREADY_BOUND');
  });
  it('keeps terminal results when delayed activity arrives', () => {
    const team = store.create('p', 'coordinator', input());
    store.bind('p', team.id, team.assignments[0].id, 'child', 'coordinator');
    store.observe('p', team.id, 'child', 'completed', 'Findings');
    store.observe('p', team.id, 'child', 'running');
    expect(store.read('p', team.id).assignments[0]).toMatchObject({
      status: 'completed',
      result: 'Findings',
    });
  });
});
