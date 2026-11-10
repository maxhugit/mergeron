import { AgentTeamVisibilityService } from './agent-team-visibility.service';
import { AgentTeamObserver } from './agent-team-observer.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectParticipants,
  projectAgentThreads,
} from '../database/schema';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { ThreadHistoryService } from '../threads/thread-history.service';
import { ThreadsService } from '../threads/threads.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import type { v2 } from '../codex/codex-schema';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamControlsService } from './agent-team-controls.service';

let database: TestDatabase,
  store: AgentTeamStore,
  controls: AgentTeamControlsService,
  identities: IdentityService,
  teamId: string,
  generation: number;
const history = { readThreadMetadata: vi.fn(), listTurns: vi.fn() };
const runtime = {
  interruptTurn: vi.fn(),
  startTurn: vi.fn(),
  resumeThread: vi.fn(),
};
const pending = { readPending: vi.fn() };
let nativeTurns: Record<string, v2.Turn[]>;
const actor = (id = 'admin'): PlatformIdentity => ({
  kind: 'person',
  personId: id,
  name: id,
  role: id === 'admin' ? 'administrator' : 'standard',
  active: true,
});
const turn = (id: string, status: v2.TurnStatus): v2.Turn => ({
  id,
  status,
  itemsView: 'full',
  items: [
    {
      type: 'agentMessage',
      id: 'answer-' + id,
      text: 'Retained findings',
      phase: 'final_answer',
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
  ],
  error: null,
  startedAt: 1,
  completedAt: status === 'inProgress' ? null : 2,
  durationMs: 1,
});
beforeEach(() => {
  database = createTestDatabase();
  store = new AgentTeamStore(database.db);
  generation = 1;
  database.db
    .insert(people)
    .values(
      ['admin', 'member', 'outsider'].map((id) => ({
        id,
        reference: id,
        name: id,
        role:
          id === 'admin' ? ('administrator' as const) : ('standard' as const),
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
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
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: 1 })
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
  store.discoverSpawn('parent', 'parent-turn', 'child', 'Analyze sources');
  teamId = store.list('p', 'parent')[0].id;
  identities = new IdentityService(database.db);
  nativeTurns = {
    parent: [turn('parent-turn', 'inProgress')],
    child: [turn('child-turn', 'inProgress')],
  };
  history.readThreadMetadata.mockReset().mockImplementation((id: string) =>
    Promise.resolve({
      thread: {
        id,
        parentThreadId: id === 'child' ? 'parent' : null,
        historyMode: 'paginated',
        status: { type: 'idle' },
      },
    }),
  );
  history.listTurns
    .mockReset()
    .mockImplementation(({ threadId }: { threadId: string }) =>
      Promise.resolve({
        data: nativeTurns[threadId] ?? [],
        nextCursor: null,
        backwardsCursor: null,
      }),
    );
  runtime.interruptTurn
    .mockReset()
    .mockImplementation((id: string, turnId: string) => {
      nativeTurns[id] = [turn(turnId, 'interrupted')];
      return Promise.resolve();
    });
  runtime.startTurn.mockReset();
  runtime.resumeThread.mockReset();
  pending.readPending.mockReset().mockReturnValue({ requests: [] });
  controls = new AgentTeamControlsService(
    new AgentTeamsService(store, identities, {
      assert() {},
      canRead: () => true,
    } as unknown as AgentTeamVisibilityService),
    identities,
    history as unknown as ThreadHistoryService,
    runtime as unknown as ThreadsService,
    { getGeneration: () => generation } as CodexProcessManager,
    pending as unknown as PendingApprovalsService,
    new AgentTeamObserver(store, {
      addListener: () => {},
      addLifecycleListener: () => () => {},
    } as unknown as CodexProcessManager),
  );
});
afterEach(() => database.sqlite.close());
describe('team execution controls', () => {
  it('refuses non-administrators before any native control', async () => {
    await expect(controls.stop(actor('member'), 'p', teamId)).rejects.toThrow();
    expect(runtime.interruptTurn).not.toHaveBeenCalled();
    await expect(
      controls.reconcile(actor('outsider'), 'p', teamId),
    ).rejects.toThrow();
    expect(history.listTurns).not.toHaveBeenCalled();
  });
  it('interrupts only the recorded parent turn and proven children, preserving findings', async () => {
    const result = await controls.stop(actor(), 'p', teamId);
    expect(runtime.interruptTurn.mock.calls).toEqual([
      ['parent', 'parent-turn'],
      ['child', 'child-turn'],
    ]);
    expect(result.state).toBe('stopped');
    expect(result.assignments[0]).toMatchObject({
      status: 'cancelled',
      result: 'Retained findings',
    });
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(runtime.resumeThread).not.toHaveBeenCalled();
  });
  it('does not interrupt a newer unrelated coordinator turn', async () => {
    nativeTurns.parent = [
      turn('newer', 'inProgress'),
      turn('parent-turn', 'completed'),
    ];
    await controls.stop(actor(), 'p', teamId);
    expect(runtime.interruptTurn).not.toHaveBeenCalledWith('parent', 'newer');
    expect(runtime.interruptTurn).toHaveBeenCalledWith('child', 'child-turn');
  });
  it('keeps an unsuccessful stop explicitly uncertain, never as success', async () => {
    runtime.interruptTurn.mockRejectedValue(new Error('transport unavailable'));
    const result = await controls.stop(actor(), 'p', teamId);
    expect(result).toMatchObject({
      state: 'unknown',
      lastError: 'TEAM_STOP_UNCONFIRMED',
    });
    expect(result.assignments[0].status).toBe('unknown');
  });
  it('does not treat idle metadata and empty history as completion', async () => {
    nativeTurns.child = [];
    const result = await controls.reconcile(actor(), 'p', teamId);
    expect(result.assignments[0].status).toBe('unknown');
    expect(runtime.startTurn).not.toHaveBeenCalled();
  });
  it('requires fresh native parent evidence before reading child messages', async () => {
    history.readThreadMetadata.mockResolvedValue({
      thread: { id: 'child', parentThreadId: 'other' },
    });
    const assignment = store.read('p', teamId).assignments[0];
    await expect(
      controls.messages(actor('member'), 'p', teamId, assignment.id),
    ).rejects.toThrow('TEAM_NATIVE_PARENT_MISMATCH');
    expect(history.listTurns).not.toHaveBeenCalled();
  });
  it('rechecks revoked membership after an asynchronous history read', async () => {
    history.listTurns.mockImplementation(() => {
      database.db
        .delete(projectParticipants)
        .where(eq(projectParticipants.personId, 'member'))
        .run();
      return Promise.resolve({ data: nativeTurns.child, nextCursor: null });
    });
    const assignment = store.read('p', teamId).assignments[0];
    await expect(
      controls.messages(actor('member'), 'p', teamId, assignment.id),
    ).rejects.toThrow();
  });
  it('refuses stale generation evidence without issuing a control', async () => {
    history.listTurns.mockImplementation(() => {
      generation++;
      return Promise.resolve({ data: nativeTurns.parent, nextCursor: null });
    });
    const result = await controls.stop(actor(), 'p', teamId);
    expect(result.state).toBe('unknown');
    expect(runtime.interruptTurn).not.toHaveBeenCalled();
  });
  it('keeps approval decisions on the existing instance-bound path and only exposes them to administrators', () => {
    const request = {
      instanceId: 'immutable',
      threadId: 'child',
      generation: 1,
      status: 'pending',
    };
    pending.readPending.mockReturnValue({ requests: [request] });
    expect(controls.details(actor(), 'p', teamId).requests).toEqual([request]);
    expect(pending.readPending).toHaveBeenCalledWith(['parent', 'child']);
    expect(controls.details(actor('member'), 'p', teamId)).toMatchObject({
      canRespond: false,
      requests: [],
    });
  });
  it('reads bounded child messages without acquiring writer ownership', async () => {
    const assignment = store.read('p', teamId).assignments[0];
    const response = await controls.messages(
      actor('member'),
      'p',
      teamId,
      assignment.id,
    );
    expect(response.messages).toEqual([
      { id: 'answer-child-turn', role: 'agent', text: 'Retained findings' },
    ]);
    expect(history.listTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'child',
        limit: 10,
        itemsView: 'full',
      }),
    );
    expect(runtime.resumeThread).not.toHaveBeenCalled();
  });
});
it('recovers a lost acknowledgement from persisted native plan and spawn evidence without sending work', async () => {
  const planned = store.create('p', 'parent', {
    requestId: 'lost',
    objective: 'Recover this mission',
    assignments: [{ key: 'read', role: 'Reader', instructions: 'Analyze' }],
  });
  store.state('p', planned.id, 'unknown', 'TEAM_DISPATCH_UNCERTAIN');
  const accepted = turn('accepted-turn', 'completed');
  accepted.items = [
    {
      type: 'userMessage',
      id: 'native-user',
      content: [
        {
          type: 'text',
          text: `<mergeron_team_plan>\nTeam dispatch reference: [mergeron-team:${planned.id}]\n</mergeron_team_plan>`,
          text_elements: [],
        },
      ],
    },
    {
      type: 'collabAgentToolCall',
      id: 'native-spawn',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['recovered-child'],
      prompt: `[mergeron-assignment:${planned.assignments[0].id}] Analyze`,
      agentsStates: {
        'recovered-child': { status: 'completed', message: 'Recovered answer' },
      },
    },
  ];
  nativeTurns.parent = [accepted];
  const result = await controls.reconcile(actor(), 'p', planned.id);
  expect(result).toMatchObject({
    state: 'completed',
    nativeTurnId: 'accepted-turn',
  });
  expect(result.assignments[0]).toMatchObject({
    nativeThreadId: 'recovered-child',
    status: 'completed',
    result: 'Recovered answer',
  });
  expect(runtime.startTurn).not.toHaveBeenCalled();
  expect(runtime.resumeThread).not.toHaveBeenCalled();
});
it('refuses an ambiguous duplicate plan marker instead of choosing a turn', async () => {
  const planned = store.create('p', 'parent', {
    requestId: 'ambiguous',
    objective: 'Keep uncertain',
    assignments: [{ key: 'read', role: 'Reader', instructions: 'Analyze' }],
  });
  store.state('p', planned.id, 'unknown');
  nativeTurns.parent = ['one', 'two'].map((id) => ({
    ...turn(id, 'completed'),
    items: [
      {
        type: 'userMessage',
        id: `user-${id}`,
        content: [
          {
            type: 'text',
            text: `<mergeron_team_plan>\n[mergeron-team:${planned.id}]\n</mergeron_team_plan>`,
            text_elements: [],
          },
        ],
      },
    ],
  }));
  const result = await controls.reconcile(actor(), 'p', planned.id);
  expect(result).toMatchObject({ state: 'unknown', nativeTurnId: null });
  expect(runtime.startTurn).not.toHaveBeenCalled();
});
it('does not present a newer unrelated coordinator or child approval as this mission’s request', () => {
  store.bindChildTurn('child', 'child-turn');
  const correct = {
    instanceId: 'correct',
    threadId: 'parent',
    turnId: 'parent-turn',
    generation: 1,
    status: 'pending',
  };
  pending.readPending.mockReturnValue({
    requests: [
      { ...correct, instanceId: 'different-parent', turnId: 'new-parent-turn' },
      {
        ...correct,
        instanceId: 'different-child',
        threadId: 'child',
        turnId: 'new-child-turn',
      },
      correct,
    ],
  });
  expect(controls.details(actor(), 'p', teamId).requests).toEqual([correct]);
});
