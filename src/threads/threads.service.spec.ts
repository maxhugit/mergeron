import { Test, TestingModule } from '@nestjs/testing';
import { ThreadsService } from './threads.service';
import { CodexService } from '../codex/codex.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { ErrorCode } from '../common/error-codes';
import { ThreadsBranchingService } from './threads-branching.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadHistoryService } from './thread-history.service';
import { ThreadsOverviewService } from './threads-overview.service';
import { ThreadMetadataService } from './thread-metadata.service';
import { ThreadWorkspaceOverridesService } from './thread-workspace-overrides.service';
import { ProjectConnectionPolicyService } from './project-connection-policy.service';
import { ProjectKnowledgeService } from '../project-knowledge/project-knowledge.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';

/** Branch state as the local-only service reports it for an untracked thread. */
function localBranchState(threadId: string) {
  return {
    threadId,
    treeRootThreadId: threadId,
    tracked: false,
    hasKnownDescendants: false,
    knownTreeThreadIds: [threadId],
  };
}

describe('ThreadsService', () => {
  let service: ThreadsService;
  const mockCodex = { request: vi.fn() };
  const mockResumeRegistry = {
    ensureOpened: vi.fn(),
    markResumed: vi.fn(),
    cacheResponse: vi.fn(),
    getGeneration: vi.fn(() => 1),
    forget: vi.fn(),
  };
  const mockBranches = {
    attachPendingVersionTurn: vi.fn(),
    hasKnownDescendants: vi.fn(),
    listKnownTreeThreadIds: vi.fn(),
    listBranchTrees: vi.fn(),
    readBranchState: vi.fn(),
    readBranchTree: vi.fn(),
    recordMessageBranch: vi.fn(),
    resolveTreeRootThreadId: vi.fn(),
    setActiveMember: vi.fn(),
    hasForkEdge: vi.fn(),
  };
  const mockBranchMutations = { recordLocalFork: vi.fn() };
  const mockBranching = {
    createMessageBranch: vi.fn(),
  };
  const mockDeletionRegistry = {
    assertMutable: vi.fn(),
  };
  const mockHistory = {
    readThreadMetadata: vi.fn(),
    listTurns: vi.fn(),
    countTurnsForThreads: vi.fn(),
    listAllTurnIds: vi.fn(),
  };
  const mockOverview = {
    listOverview: vi.fn(),
  };
  const mockMetadata = {
    publishStartedThread: vi.fn(),
    getHeldThread: vi.fn(),
  };
  const mockWorkspaceOverrides = {
    get: vi.fn(),
    setMany: vi.fn(),
  };
  const mockProjectConnections = {
    configForCwd: vi.fn(),
    policyForCwd: vi.fn(),
    recordExecutionContext: vi.fn(),
  };
  const mockKnowledge = { contextForConversation: vi.fn() };
  const mockActiveFolders = { resolveAgent: vi.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ActiveFoldersService, useValue: mockActiveFolders },
        { provide: ProjectKnowledgeService, useValue: mockKnowledge },
        ThreadsService,
        { provide: CodexService, useValue: mockCodex },
        { provide: ThreadResumeRegistryService, useValue: mockResumeRegistry },
        { provide: ConversationBranchesService, useValue: mockBranches },
        {
          provide: ConversationBranchMutationsService,
          useValue: mockBranchMutations,
        },
        { provide: ThreadsBranchingService, useValue: mockBranching },
        {
          provide: ThreadDeletionRegistryService,
          useValue: mockDeletionRegistry,
        },
        { provide: ThreadHistoryService, useValue: mockHistory },
        { provide: ThreadsOverviewService, useValue: mockOverview },
        { provide: ThreadMetadataService, useValue: mockMetadata },
        {
          provide: ThreadWorkspaceOverridesService,
          useValue: mockWorkspaceOverrides,
        },
        {
          provide: ProjectConnectionPolicyService,
          useValue: mockProjectConnections,
        },
      ],
    }).compile();

    service = module.get(ThreadsService);
    mockCodex.request.mockReset();
    mockKnowledge.contextForConversation.mockReset();
    mockActiveFolders.resolveAgent.mockReset();
    mockKnowledge.contextForConversation.mockResolvedValue(null);
    Object.values(mockResumeRegistry).forEach((mock) => mock.mockReset());
    Object.values(mockBranches).forEach((mock) => mock.mockReset());
    mockBranchMutations.recordLocalFork.mockReset();
    mockBranching.createMessageBranch.mockReset();
    mockDeletionRegistry.assertMutable.mockReset();
    Object.values(mockHistory).forEach((mock) => mock.mockReset());
    mockOverview.listOverview.mockReset();
    Object.values(mockMetadata).forEach((mock) => mock.mockReset());
    Object.values(mockWorkspaceOverrides).forEach((mock) => mock.mockReset());
    mockProjectConnections.configForCwd.mockReset();
    mockProjectConnections.configForCwd.mockResolvedValue(null);
    mockProjectConnections.policyForCwd.mockReset();
    mockProjectConnections.policyForCwd.mockResolvedValue(null);
    mockProjectConnections.recordExecutionContext.mockReset();
    mockBranches.hasKnownDescendants.mockReturnValue(false);
    mockBranches.hasForkEdge.mockReturnValue(false);
    mockBranches.listKnownTreeThreadIds.mockImplementation(
      (threadId: string): string[] => [threadId],
    );
    mockBranches.resolveTreeRootThreadId.mockImplementation(
      (threadId: string): string => threadId,
    );
  });

  it('starts new threads in paginated history mode', async () => {
    const response = {
      thread: { id: 't1', historyMode: 'paginated' },
      model: 'gpt-4',
    };
    mockCodex.request.mockResolvedValue(response);

    const result = await service.startThread({});

    expect(result).toEqual(response);
    expect(mockCodex.request).toHaveBeenCalledWith('thread/start', {
      historyMode: 'paginated',
    });
    expect(mockResumeRegistry.markResumed).toHaveBeenCalledWith('t1');
    expect(mockMetadata.publishStartedThread).toHaveBeenCalledWith(
      response.thread,
    );
  });

  it('applies the owning project connection policy to a new thread', async () => {
    const response = {
      thread: { id: 't1', historyMode: 'paginated' },
      model: 'gpt-4',
    };
    mockProjectConnections.policyForCwd.mockResolvedValue({
      projectId: 'project-1',
      model: 'gpt-project',
      reasoningEffort: 'high',
      config: {
        apps: { _default: { enabled: false }, gmail: { enabled: true } },
      },
    });
    mockCodex.request.mockResolvedValue(response);

    await service.startThread({
      cwd: '/workspaces/mail',
      config: { web_search: 'cached' },
    });

    expect(mockCodex.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/workspaces/mail',
      model: 'gpt-project',
      config: {
        web_search: 'cached',
        apps: { _default: { enabled: false }, gmail: { enabled: true } },
        model_reasoning_effort: 'high',
      },
      historyMode: 'paginated',
    });
  });

  it('deletes a new thread when paginated history is not confirmed', async () => {
    mockCodex.request
      .mockResolvedValueOnce({ thread: { id: 't1', historyMode: 'legacy' } })
      .mockResolvedValueOnce({});

    await expect(service.startThread({})).rejects.toMatchObject({
      errorCode: ErrorCode.threads.paginatedHistoryRequired,
    });

    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/delete', {
      threadId: 't1',
    });
    expect(mockResumeRegistry.markResumed).not.toHaveBeenCalled();
  });

  it('should call thread/list with params', async () => {
    mockCodex.request.mockResolvedValue({ data: [], nextCursor: null });

    await service.listThreads({ limit: 10 });

    expect(mockCodex.request).toHaveBeenCalledWith('thread/list', {
      limit: 10,
    });
  });

  it('should call thread/loaded/list with params', async () => {
    mockCodex.request.mockResolvedValue({ data: ['t1'], nextCursor: null });

    await service.listLoadedThreads({ cursor: 'cursor-1', limit: 20 });

    expect(mockCodex.request).toHaveBeenCalledWith('thread/loaded/list', {
      cursor: 'cursor-1',
      limit: 20,
    });
  });

  it('reads thread metadata through the paged-history adapter', async () => {
    const response = {
      thread: { id: 't1', historyMode: 'paginated', turns: [] },
    };
    mockHistory.readThreadMetadata.mockResolvedValue(response);

    await expect(service.readThread('t1')).resolves.toEqual(response);

    expect(mockHistory.readThreadMetadata).toHaveBeenCalledWith('t1');
    expect(mockCodex.request).not.toHaveBeenCalled();
  });

  it('keeps the REST projection as a steering guard on metadata reads', async () => {
    // Metadata reads should have no turns. Supplying one here simulates a
    // future upstream regression and proves the REST boundary remains safe by
    // construction instead of depending on that assumption forever.
    mockHistory.readThreadMetadata.mockResolvedValue({
      thread: {
        id: 't1',
        historyMode: 'paginated',
        turns: [
          {
            id: 'turn-1',
            items: [],
            status: 'failed',
            error: {
              message: 'blocked',
              codexErrorInfo: 'misalignmentPolicyViolation',
              additionalDetails: null,
              misalignment: {
                errorType: 'policy',
                detailedExplanation: 'display this',
                steer: { message: 'do not send this' },
              },
            },
          },
        ],
      },
    });

    const response = await service.readThread('t1');

    expect(response.thread.turns[0]?.error?.misalignment).toEqual({
      errorType: 'policy',
      detailedExplanation: 'display this',
    });
  });

  it('should ensure resume via registry', async () => {
    const response = {
      mode: 'writable',
      ownership: 'acquired',
      thread: { id: 't1', forkedFromId: null },
      cwd: '/tmp',
    };
    mockResumeRegistry.ensureOpened.mockResolvedValue(response);

    await expect(service.resumeThread('t1')).resolves.toBe(response);
    expect(mockResumeRegistry.ensureOpened).toHaveBeenCalledWith('t1');
    expect(mockBranches.setActiveMember).toHaveBeenCalledWith('t1', 't1');
  });

  it('does not move the active-branch pointer on a background reopen', async () => {
    // Refresh recovery, reconnect recovery and app-server auto-resume all walk
    // every loaded thread. If those writes counted, each tree would end up
    // pointing at whichever member happened to be restored last — which is the
    // behaviour the pointer exists to prevent, reintroduced by the mechanism
    // meant to preserve it.
    mockResumeRegistry.ensureOpened.mockResolvedValue({
      mode: 'writable',
      ownership: 'acquired',
      thread: { id: 't1', forkedFromId: null },
      cwd: '/tmp',
    });

    await service.resumeThread('t1', { recordActive: false });

    expect(mockBranches.setActiveMember).not.toHaveBeenCalled();
  });

  it('does not write an active-branch pointer for a thread being deleted', async () => {
    // Resolving the tree root can await app-server reads, so a delete may claim
    // the thread in between. Deletion clears pointers during cleanup, and a
    // write landing afterwards would reinstate one naming a destroyed thread.
    mockResumeRegistry.ensureOpened.mockResolvedValue({
      mode: 'writable',
      ownership: 'acquired',
      thread: { id: 't1', forkedFromId: null },
      cwd: '/tmp',
    });
    // Mutable when the open begins; claimed by the time the pointer resolves.
    let checks = 0;
    mockDeletionRegistry.assertMutable.mockImplementation(() => {
      checks += 1;
      if (checks > 1) throw new Error('thread is being deleted');
    });

    await service.resumeThread('t1');
    // The pointer write is fire-and-forget, so let its microtasks settle.
    await Promise.resolve();

    expect(mockBranches.setActiveMember).not.toHaveBeenCalled();
  });

  it('delegates branch-collapsed overview projection', async () => {
    const response = { data: [], nextCursor: null };
    mockOverview.listOverview.mockResolvedValue(response);

    await expect(service.listOverview({ limit: 10 })).resolves.toBe(response);

    expect(mockOverview.listOverview).toHaveBeenCalledWith({ limit: 10 });
  });

  it('should call turn/start', async () => {
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });

    await service.startTurn({
      threadId: 't1',
      input: [{ type: 'text', text: 'hello' }] as never,
    });

    expect(mockCodex.request).toHaveBeenCalledWith('turn/start', {
      threadId: 't1',
      input: [{ type: 'text', text: 'hello' }],
    });
    expect(mockBranches.attachPendingVersionTurn).toHaveBeenCalledWith(
      't1',
      'turn1',
      'hello',
    );
  });

  it('refreshes shared knowledge on subsequent turns without changing the cwd, user input or branch preview', async () => {
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
    mockKnowledge.contextForConversation
      .mockResolvedValueOnce('Current knowledge')
      .mockResolvedValueOnce('Updated knowledge');
    const input = [
      { type: 'text' as const, text: 'Continue', text_elements: [] },
    ];
    await service.startTurn({ threadId: 't1', cwd: '/secondary', input });
    await service.startTurn({ threadId: 't1', cwd: '/secondary', input });
    expect(mockKnowledge.contextForConversation).toHaveBeenCalledWith(
      '/secondary',
      't1',
    );
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        cwd: '/secondary',
        input: [
          { type: 'text', text: 'Updated knowledge', text_elements: [] },
          ...input,
        ],
      }),
    );
    expect(input).toHaveLength(1);
    expect(mockBranches.attachPendingVersionTurn).toHaveBeenLastCalledWith(
      't1',
      'turn1',
      'Continue',
    );
  });

  it('enforces the project model and reasoning effort on every turn', async () => {
    mockMetadata.getHeldThread.mockReturnValue({
      id: 't1',
      cwd: '/workspaces/mail',
      name: 'Mail agent',
      preview: 'Existing thread',
    });
    mockProjectConnections.policyForCwd.mockResolvedValue({
      projectId: 'project-1',
      model: 'gpt-project',
      reasoningEffort: 'xhigh',
      config: {},
    });
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });

    await service.startTurn({
      threadId: 't1',
      model: 'untrusted-model',
      effort: 'low',
      input: [{ type: 'text', text: 'hello' }] as never,
    });

    expect(mockCodex.request).toHaveBeenCalledWith('turn/start', {
      threadId: 't1',
      model: 'gpt-project',
      effort: 'xhigh',
      input: [{ type: 'text', text: 'hello' }],
    });
  });

  it('automatically names a new unnamed thread from its first message', async () => {
    mockMetadata.getHeldThread.mockReturnValue({
      id: 't1',
      name: null,
      preview: '',
    });
    mockCodex.request
      .mockResolvedValueOnce({ turn: { id: 'turn1' } })
      .mockResolvedValueOnce({});

    await service.startTurn({
      threadId: 't1',
      input: [
        { type: 'text', text: 'Planifier la migration du serveur' },
      ] as never,
    });
    await vi.waitFor(() =>
      expect(mockCodex.request).toHaveBeenCalledWith('thread/name/set', {
        threadId: 't1',
        name: 'Planifier la migration du serveur',
      }),
    );
  });

  it('preserves a name manually assigned before the first message', async () => {
    mockMetadata.getHeldThread.mockReturnValue({
      id: 't1',
      name: 'Mon agent',
      preview: '',
    });
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });

    await service.startTurn({
      threadId: 't1',
      input: [{ type: 'text', text: 'Premier message' }] as never,
    });

    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'thread/name/set',
      expect.anything(),
    );
  });

  it('should call turn/steer', async () => {
    mockCodex.request.mockResolvedValue({ turnId: 'turn1' });

    await service.steerTurn({
      threadId: 't1',
      expectedTurnId: 'turn1',
      input: [{ type: 'text', text: 'keep going' }] as never,
    });

    expect(mockCodex.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 't1',
      expectedTurnId: 'turn1',
      input: [{ type: 'text', text: 'keep going' }],
    });
  });

  it('should call turn/interrupt', async () => {
    mockCodex.request.mockResolvedValue({});

    await service.interruptTurn('t1', 'turn1');

    expect(mockCodex.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 't1',
      turnId: 'turn1',
    });
  });

  it('archives every locally tracked member of a branch tree', async () => {
    mockBranches.listKnownTreeThreadIds.mockReturnValue(['root', 'child']);
    mockCodex.request.mockResolvedValue({});

    await service.archiveThread('child');

    expect(mockCodex.request).toHaveBeenNthCalledWith(1, 'thread/archive', {
      threadId: 'root',
    });
    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/archive', {
      threadId: 'child',
    });
    expect(mockResumeRegistry.forget).toHaveBeenCalledWith('root');
    expect(mockResumeRegistry.forget).toHaveBeenCalledWith('child');
  });

  it('attempts every tree member before reporting an archive failure', async () => {
    mockBranches.listKnownTreeThreadIds.mockReturnValue(['root', 'child']);
    mockCodex.request
      .mockRejectedValueOnce(new Error('root archive failed'))
      .mockResolvedValueOnce({});

    await expect(service.archiveThread('child')).rejects.toThrow(
      'root archive failed',
    );

    // Stopping at the first failure would leave the tree half-archived.
    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/archive', {
      threadId: 'child',
    });
  });

  it('blocks compaction when a thread has known descendants', async () => {
    mockBranches.readBranchState.mockReturnValue({
      ...localBranchState('root'),
      hasKnownDescendants: true,
    });
    mockCodex.request.mockResolvedValue({ data: [], nextCursor: null });

    await expect(service.compactThread('root')).rejects.toMatchObject({
      errorCode: ErrorCode.threads.compactBlockedByDescendants,
    });

    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'thread/compact/start',
      expect.anything(),
    );
  });

  it('blocks compaction when app-server exposes an external fork descendant', async () => {
    mockBranches.readBranchState.mockReturnValue(localBranchState('root'));
    mockCodex.request
      .mockResolvedValueOnce({
        data: [{ id: 'child', forkedFromId: 'root' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ data: [], nextCursor: null });

    await expect(service.compactThread('root')).rejects.toMatchObject({
      errorCode: ErrorCode.threads.compactBlockedByDescendants,
    });

    // Archived forks still read the parent's history, so both pages matter.
    expect(mockCodex.request).toHaveBeenNthCalledWith(1, 'thread/list', {
      cursor: undefined,
      limit: 200,
      archived: false,
      modelProviders: [],
    });
    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/list', {
      cursor: undefined,
      limit: 200,
      archived: true,
      modelProviders: [],
    });
  });

  it('answers branch state from local topology without listing threads', () => {
    const state = localBranchState('root');
    mockBranches.readBranchState.mockReturnValue(state);

    expect(service.readBranchState('root')).toBe(state);
    expect(mockCodex.request).not.toHaveBeenCalled();
  });

  it('delegates tracked message branch creation', async () => {
    const response = {
      fork: { thread: { id: 'child' } },
      tree: {
        treeRootThreadId: 'root',
        tracked: true,
        members: [],
        groups: [],
      },
      group: {
        groupId: 'group',
        treeRootThreadId: 'root',
        commonPrefixTurnId: null,
        createdAt: 1,
        updatedAt: 1,
        versions: [],
      },
      version: {
        versionId: 'version',
        groupId: 'group',
        threadId: 'child',
        versionIndex: 2,
        kind: 'branch',
        messageTurnId: null,
        previewText: 'edited',
        createdAt: 1,
        updatedAt: 1,
      },
    };
    mockBranching.createMessageBranch.mockResolvedValue(response);

    await expect(
      service.createMessageBranch('source', {
        editedTurnId: 'turn-a',
        previewText: 'edited',
      }),
    ).resolves.toBe(response);

    expect(mockBranching.createMessageBranch).toHaveBeenCalledWith('source', {
      editedTurnId: 'turn-a',
      previewText: 'edited',
    });
  });

  it('forks with deferred goal continuation only when requested', async () => {
    mockHistory.readThreadMetadata.mockResolvedValue({
      thread: { id: 'source', historyMode: 'paginated' },
    });
    mockHistory.listAllTurnIds.mockResolvedValue(['turn-1']);
    mockCodex.request.mockResolvedValue({
      thread: {
        id: 'child',
        historyMode: 'paginated',
        forkedFromId: 'source',
      },
      model: 'gpt-5',
    });

    await service.forkThread('source', { carryGoal: true });

    expect(mockCodex.request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'source',
      excludeTurns: true,
      deferGoalContinuation: true,
    });
    expect(mockBranchMutations.recordLocalFork).toHaveBeenCalledWith({
      sourceThreadId: 'source',
      childThreadId: 'child',
      treeRootThreadId: 'source',
      inheritedTurnIds: ['turn-1'],
    });
    expect(mockResumeRegistry.markResumed).toHaveBeenCalledWith('child');
  });

  it('never deletes when app-server reuses the source ID for a fork', async () => {
    mockHistory.readThreadMetadata.mockResolvedValue({
      thread: { id: 'source', historyMode: 'paginated' },
    });
    mockCodex.request.mockResolvedValue({
      thread: { id: 'source', historyMode: 'paginated' },
    });

    await expect(service.forkThread('source')).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchForkUnsupported,
    });

    expect(mockCodex.request).toHaveBeenCalledTimes(1);
    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'thread/delete',
      expect.anything(),
    );
    expect(mockBranchMutations.recordLocalFork).not.toHaveBeenCalled();
  });

  it('deletes an untracked child when ordinary-fork provenance fails', async () => {
    mockHistory.readThreadMetadata.mockResolvedValue({
      thread: { id: 'source', historyMode: 'paginated' },
    });
    mockHistory.listAllTurnIds.mockResolvedValue(['turn-1']);
    mockCodex.request
      .mockResolvedValueOnce({
        thread: {
          id: 'child',
          historyMode: 'paginated',
          forkedFromId: 'source',
        },
      })
      .mockResolvedValueOnce({});
    mockBranchMutations.recordLocalFork.mockImplementation(() => {
      throw new Error('database failed');
    });

    await expect(service.forkThread('source')).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchMetadataFailed,
    });

    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/delete', {
      threadId: 'child',
    });
  });

  it('preserves a child once its ordinary-fork edge is durable', async () => {
    mockHistory.readThreadMetadata.mockResolvedValue({
      thread: { id: 'source', historyMode: 'paginated' },
    });
    mockHistory.listAllTurnIds.mockResolvedValue(['turn-1']);
    mockCodex.request.mockResolvedValueOnce({
      thread: {
        id: 'child',
        historyMode: 'paginated',
        forkedFromId: 'source',
      },
    });
    mockBranchMutations.recordLocalFork.mockImplementation(() => {
      throw new Error('response failed after commit');
    });
    mockBranches.hasForkEdge.mockReturnValue(true);

    await expect(service.forkThread('source')).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchMetadataFailed,
    });

    expect(mockCodex.request).toHaveBeenCalledTimes(1);
    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'thread/delete',
      expect.anything(),
    );
  });

  it('rejects fork requests that combine goal carry with ephemeral forks', async () => {
    await expect(
      service.forkThread('source', { carryGoal: true, ephemeral: true }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.invalidForkOptions,
    });
  });
});
