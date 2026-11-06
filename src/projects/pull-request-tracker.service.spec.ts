import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectAgentThreads,
  projectPullRequestAgents,
  people,
  agentMonitors,
} from '../database/schema';
import {
  PullRequestTrackerService,
  PR_CLAIM_TTL,
} from './pull-request-tracker.service';
import type { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import type { ThreadMetadataService } from '../threads/thread-metadata.service';
import { accessContext } from '../auth/access-context';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';

let db: TestDatabase;
let tracker: PullRequestTrackerService;
let turns: string[];
beforeEach(() => {
  db = createTestDatabase();
  for (const id of ['p', 'other'])
    db.db
      .insert(projects)
      .values({
        id,
        name: id,
        workspacePath: '/work/' + id,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  for (const threadId of ['a', 'b'])
    db.db
      .insert(projectAgentThreads)
      .values({
        threadId,
        projectId: 'p',
        workspacePath: '/work',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  turns = ['turn-1'];
  tracker = new PullRequestTrackerService(
    db.db,
    {
      activeTurnIds: () => turns,
    } as unknown as ThreadExecutionInventoryService,
    {
      getHeldThread: (id: string) => ({ name: 'Agent ' + id }),
    } as unknown as ThreadMetadataService,
  );
});
afterEach(() => {
  db.sqlite.close();
  vi.useRealTimers();
});

it('retains the confirmed creator independently of another agent’s work and repository casing', () => {
  tracker.created('p', 'Owner/Repo', 12, 'a');
  tracker.claim('p', 'owner/repo', 12, 'b', 'working', 'turn-1');
  expect(tracker.snapshot('p', 'OWNER/REPO', 12)).toMatchObject({
    creator: { threadId: 'a', name: 'Agent a' },
    agents: [
      { threadId: 'a', phase: 'idle' },
      { threadId: 'b', phase: 'working' },
    ],
  });
  expect(tracker.snapshot('p', 'owner/another', 12)).toEqual({
    creator: null,
    agents: [],
  });
  tracker.created('p', 'owner/repo', 12, 'b');
  expect(tracker.snapshot('p', 'owner/repo', 12).creator?.threadId).toBe('a');
});
it('never revives a completed claim because an unrelated turn started', () => {
  tracker.claim('p', 'o/r', 12, 'a', 'working', 'turn-1');
  turns = ['unrelated-turn'];
  expect(tracker.snapshot('p', 'o/r', 12).agents[0].phase).toBe('idle');
  expect(() => tracker.claim('p', 'o/r', 12, 'a', 'working', 'turn-1')).toThrow(
    'PR_EXECUTION_NOT_OBSERVED',
  );
});
it('expires abandoned work, permits renewal, and releases work explicitly', () => {
  vi.useFakeTimers();
  tracker.claim('p', 'o/r', 12, 'a', 'working', 'turn-1');
  vi.advanceTimersByTime(PR_CLAIM_TTL + 1);
  expect(tracker.snapshot('p', 'o/r', 12).agents[0].phase).toBe('idle');
  tracker.claim('p', 'o/r', 12, 'a', 'working', 'turn-1');
  expect(tracker.snapshot('p', 'o/r', 12).agents[0].phase).toBe('working');
  tracker.claim('p', 'o/r', 12, 'a', 'idle');
  expect(tracker.snapshot('p', 'o/r', 12).agents[0].phase).toBe('idle');
});
it('does not invent a creator when an agent associates a terminal-created PR', () => {
  tracker.claim('p', 'o/r', 12, 'a', 'idle');
  expect(tracker.snapshot('p', 'o/r', 12)).toMatchObject({
    creator: null,
    agents: [{ threadId: 'a' }],
  });
});

it('keeps a real monitor visible across unrelated human turns and stops it when paused', () => {
  db.db
    .insert(people)
    .values({
      id: 'person',
      reference: 'person',
      name: 'Person',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.db
    .insert(agentMonitors)
    .values({
      id: 'monitor',
      projectId: 'p',
      threadId: 'a',
      personId: 'person',
      requestId: 'r',
      fingerprint: 'f',
      name: 'Check PR',
      instructions: 'Check PR 12',
      expiresAt: Date.now() + 60_000,
      maxRuns: 5,
      maxRunMs: 60_000,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  tracker.claim('p', 'o/r', 12, 'a', 'watching', undefined, 'monitor');
  turns = ['human-conversation'];
  expect(tracker.snapshot('p', 'o/r', 12).agents[0].phase).toBe('watching');
  expect(() =>
    tracker.claim('p', 'o/r', 12, 'b', 'watching', undefined, 'monitor'),
  ).toThrow('PR_MONITOR_NOT_ACTIVE');
  db.sqlite
    .prepare('UPDATE agent_monitors SET status=? WHERE id=?')
    .run('paused', 'monitor');
  expect(tracker.snapshot('p', 'o/r', 12).agents[0].phase).toBe('idle');
});
it('refuses cross-project, archived and missing agents and nonexistent monitors', () => {
  expect(() => tracker.claim('other', 'o/r', 12, 'a', 'idle')).toThrow(
    'PR_AGENT_UNAVAILABLE',
  );
  expect(() => tracker.claim('p', 'o/r', 12, 'missing', 'idle')).toThrow(
    'PR_AGENT_UNAVAILABLE',
  );
  expect(() =>
    tracker.claim('p', 'o/r', 12, 'a', 'watching', undefined, 'fake'),
  ).toThrow('PR_MONITOR_NOT_ACTIVE');
  db.sqlite
    .prepare('UPDATE project_agent_threads SET archived_at=1 WHERE thread_id=?')
    .run('a');
  expect(() => tracker.claim('p', 'o/r', 12, 'a', 'idle')).toThrow(
    'PR_AGENT_UNAVAILABLE',
  );
});
it('hides creator names and activity when the caller cannot read the conversation', () => {
  tracker.created('p', 'o/r', 12, 'a');
  const context = {
    identity: {} as PlatformIdentity,
    identities: {
      requireProject: vi.fn(),
      canReadThread: () => false,
    } as unknown as IdentityService,
  };
  expect(
    accessContext.run(context, () => tracker.snapshot('p', 'o/r', 12)),
  ).toEqual({ creator: null, agents: [] });
});
it('cleans agent associations when an agent is deleted, without reattributing the creator', () => {
  tracker.created('p', 'o/r', 12, 'a');
  db.sqlite
    .prepare('DELETE FROM project_agent_threads WHERE thread_id=?')
    .run('a');
  expect(db.db.select().from(projectPullRequestAgents).all()).toHaveLength(0);
  expect(tracker.snapshot('p', 'o/r', 12)).toEqual({
    creator: null,
    agents: [],
  });
});
