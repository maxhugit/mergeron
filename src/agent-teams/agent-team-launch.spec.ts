import { AgentTeamBusinessService } from './agent-team-business.service';
import { AgentTeamVisibilityService } from './agent-team-visibility.service';
import { ProjectConnectionPolicyService } from '../threads/project-connection-policy.service';
import type { ActiveFoldersService } from '../active-folders/active-folders.service';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { people, projects, projectAgentThreads } from '../database/schema';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamLaunchService } from './agent-team-launch.service';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import type { CodexService } from '../codex/codex.service';
import type {
  ThreadsService,
  BackgroundTurnGuard,
} from '../threads/threads.service';
import type { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import type { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
let database: TestDatabase,
  store: AgentTeamStore,
  service: AgentTeamLaunchService;
const actor: PlatformIdentity = {
  kind: 'person',
  personId: 'admin',
  name: 'Admin',
  role: 'administrator',
  active: true,
};
const start = vi.fn(),
  request = vi.fn(),
  busy = vi.fn();
beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values({
      id: 'admin',
      reference: 'admin',
      name: 'Admin',
      role: 'administrator',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'P',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values({
      projectId: 'p',
      threadId: 'parent',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  store = new AgentTeamStore(database.db);
  const identities = new IdentityService(database.db);
  request.mockReset().mockResolvedValue({
    data: [{ name: 'multi_agent', enabled: true, stage: 'stable' }],
    nextCursor: null,
  });
  busy.mockReset().mockReturnValue(false);
  start
    .mockReset()
    .mockImplementation((_params: unknown, guard: BackgroundTurnGuard) => {
      guard.assertIdle();
      guard.beforeSend();
      return Promise.resolve({ turn: { id: 'turn' } });
    });
  service = new AgentTeamLaunchService(
    database.db,
    new AgentTeamsService(store, identities, {
      assert() {},
      canRead: () => true,
    } as unknown as AgentTeamVisibilityService),
    identities,
    { request } as unknown as CodexService,
    { startTurn: start } as unknown as ThreadsService,
    {
      has: busy,
      snapshot: () => [],
      parentOf: () => null,
    } as unknown as ThreadExecutionInventoryService,
    { listPending: () => [] } as unknown as PendingApprovalsService,
    { assertLaunch() {} } as unknown as AgentTeamBusinessService,
  );
});
afterEach(() => database.sqlite.close());
const prepare = (requestId = 'one') =>
  service.prepare(actor, 'p', 'parent', {
    requestId,
    objective: 'Prepare a dossier',
  });
it('snapshots profiles and preserves request idempotency', () => {
  const first = prepare();
  expect(prepare().id).toBe(first.id);
  const profiles = service
    .profiles(actor, 'p', 'parent')
    .map((p) => ({ ...p, instructions: 'New role instructions' }));
  service.saveProfiles(actor, 'p', 'parent', profiles);
  expect(store.read('p', first.id).assignments[0].instructions).not.toBe(
    'New role instructions',
  );
  expect(service.profiles(actor, 'p', 'parent')[0].instructions).toBe(
    'New role instructions',
  );
});
it('refuses profile cycles without changing the saved profile set', () => {
  expect(() =>
    service.saveProfiles(actor, 'p', 'parent', [
      { key: 'a', role: 'A', instructions: 'Read', dependencies: ['a'] },
    ]),
  ).toThrow('TEAM_DEPENDENCY_CYCLE');
  expect(service.profiles(actor, 'p', 'parent')).toHaveLength(3);
});
it('dispatches one native coordinator turn with stable assignment markers', async () => {
  const team = prepare();
  const result = await service.launch(actor, 'p', team.id);
  expect(result).toMatchObject({
    state: 'running',
    nativeTurnId: 'turn',
    launchedBy: 'admin',
  });
  expect(
    (start.mock.calls[0][0] as { input: Array<{ text: string }> }).input[0]
      .text,
  ).toContain(`[mergeron-assignment:${team.assignments[0].id}]`);
  await expect(service.launch(actor, 'p', team.id)).rejects.toThrow(
    'TEAM_ALREADY_DISPATCHED',
  );
  expect(start).toHaveBeenCalledTimes(1);
});
it('keeps pre-send failures safely retryable without native dispatch', async () => {
  const team = prepare();
  busy.mockReturnValue(true);
  await expect(service.launch(actor, 'p', team.id)).rejects.toThrow(
    'TEAM_COORDINATOR_BUSY',
  );
  expect(store.read('p', team.id).state).toBe('draft');
  expect(start).not.toHaveBeenCalled();
});
it('fails closed when native subagents are disabled instead of enabling them', async () => {
  const team = prepare();
  request.mockResolvedValue({
    data: [{ name: 'multi_agent', enabled: false }],
    nextCursor: null,
  });
  await expect(service.launch(actor, 'p', team.id)).rejects.toThrow(
    'TEAM_NATIVE_SUBAGENTS_UNAVAILABLE',
  );
  expect(start).not.toHaveBeenCalled();
});
it('quarantines an uncertain send and blocks another team on this coordinator', async () => {
  const team = prepare(),
    next = prepare('two');
  start.mockImplementation((_params: unknown, guard: BackgroundTurnGuard) => {
    guard.beforeSend();
    return Promise.reject(new Error('Connection lost'));
  });
  await expect(service.launch(actor, 'p', team.id)).rejects.toThrow(
    'Connection lost',
  );
  expect(store.read('p', team.id)).toMatchObject({
    state: 'unknown',
    lastError: 'TEAM_DISPATCH_UNCERTAIN',
  });
  service.onModuleInit();
  expect(store.read('p', team.id).state).toBe('unknown');
  await expect(service.launch(actor, 'p', next.id)).rejects.toThrow(
    'TEAM_COORDINATOR_HAS_UNRESOLVED_TEAM',
  );
  expect(start).toHaveBeenCalledTimes(1);
});
it('accepts native events arriving before the dispatch acknowledgement without rebinding', async () => {
  const team = prepare();
  start.mockImplementation((_params: unknown, guard: BackgroundTurnGuard) => {
    guard.beforeSend();
    store.bindDispatchTurn('parent', 'event-turn');
    return Promise.resolve({ turn: { id: 'event-turn' } });
  });
  expect((await service.launch(actor, 'p', team.id)).nativeTurnId).toBe(
    'event-turn',
  );
  store.bindDispatchTurn('parent', 'different');
  expect(store.read('p', team.id).nativeTurnId).toBe('event-turn');
});
it('applies the native cap only to a project-bound active or quarantined team', async () => {
  const team = prepare();
  store.state('p', team.id, 'preparing');
  const policy = new ProjectConnectionPolicyService(
    {
      request: (method: string) =>
        Promise.resolve(
          method === 'config/read'
            ? { config: {} }
            : { data: [], nextCursor: null },
        ),
    } as unknown as CodexService,
    database.db,
    {
      executionLocationForCwd: () => ({
        projectId: 'p',
        workspaceId: 'w',
        readOnly: false,
        sourceResourceId: null,
        sourceRevision: null,
      }),
    } as unknown as ActiveFoldersService,
  );
  expect(
    (await policy.policyForCwd('/p', 'p', 'parent'))?.config.agents,
  ).toEqual({ max_threads: 2 });
  expect(
    (await policy.policyForCwd('/p', 'p', 'unrelated'))?.config.agents,
  ).toBeUndefined();
  store.state('p', team.id, 'unknown');
  expect(
    (await policy.policyForCwd('/p', 'p', 'parent'))?.config.agents,
  ).toEqual({ max_threads: 2 });
  store.state('p', team.id, 'completed');
  expect(
    (await policy.policyForCwd('/p', 'p', 'parent'))?.config.agents,
  ).toBeUndefined();
});
