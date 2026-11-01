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
import { CodexRpcError } from '../codex/codex-errors';
import { ProjectAgentToolsService } from '../project-knowledge/project-agent-tools.service';
import { ProjectAgentDefaultsService } from './project-agent-defaults.service';
import { InternalMcpService } from '../internal-mcp/internal-mcp.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import { ThreadExecutionPreferencesService } from './thread-execution-preferences.service';
import { accessContext } from '../auth/access-context';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';
import { createTestDatabase } from '../database/database.testing';
import { projects, projectAgentThreads } from '../database/schema';

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
    isResumed: vi.fn(() => true),
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
    policyForThread: vi.fn(),
    assertExecutionLocation: vi.fn(),
    assertCopyOwnership: vi.fn(),
    recordExecutionContext: vi.fn(),
  };
  const cachedPermissionProfile = vi.fn();
  const mockKnowledge = { contextForConversation: vi.fn() };
  const mockActiveFolders = { resolveAgent: vi.fn() };
  const mockProjectTools = { context: vi.fn() };
  const mockAgentDefaults = { forNewAgent: vi.fn() };
  const mockInternalMcp = { prepare: vi.fn(), revoke: vi.fn() };
  const mockSettings = { readSecurityPolicy: vi.fn() };
  const mockPreferences = { forTurn: vi.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ActiveFoldersService, useValue: mockActiveFolders },
        { provide: ProjectKnowledgeService, useValue: mockKnowledge },
        { provide: ProjectAgentToolsService, useValue: mockProjectTools },
        { provide: ProjectAgentDefaultsService, useValue: mockAgentDefaults },
        { provide: InternalMcpService, useValue: mockInternalMcp },
        { provide: ThreadSettingsObserverService, useValue: mockSettings },
        {
          provide: ThreadExecutionPreferencesService,
          useValue: mockPreferences,
        },
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
    mockPreferences.forTurn.mockReset().mockReturnValue({});
    mockCodex.request.mockReset();
    mockInternalMcp.prepare.mockReset().mockReturnValue(null);
    mockInternalMcp.revoke.mockReset();
    mockSettings.readSecurityPolicy
      .mockReset()
      .mockReturnValue({ sandboxPolicy: null });
    mockAgentDefaults.forNewAgent.mockReset().mockResolvedValue({});
    mockKnowledge.contextForConversation.mockReset();
    mockProjectTools.context.mockReset();
    mockProjectTools.context.mockReturnValue(null);
    mockActiveFolders.resolveAgent.mockReset();
    mockKnowledge.contextForConversation.mockResolvedValue(null);
    Object.values(mockResumeRegistry).forEach((mock) => mock.mockReset());
    mockResumeRegistry.isResumed.mockReturnValue(true);
    Object.values(mockBranches).forEach((mock) => mock.mockReset());
    mockBranchMutations.recordLocalFork.mockReset();
    mockBranching.createMessageBranch.mockReset();
    mockDeletionRegistry.assertMutable.mockReset();
    Object.values(mockHistory).forEach((mock) => mock.mockReset());
    mockOverview.listOverview.mockReset();
    Object.values(mockMetadata).forEach((mock) => mock.mockReset());
    Object.values(mockWorkspaceOverrides).forEach((mock) => mock.mockReset());
    Object.assign(mockResumeRegistry, {
      readCachedPermissionProfile: cachedPermissionProfile,
    });
    cachedPermissionProfile.mockReset();
    mockProjectConnections.configForCwd.mockReset();
    mockProjectConnections.configForCwd.mockResolvedValue(null);
    mockProjectConnections.policyForCwd.mockReset();
    mockProjectConnections.policyForCwd.mockResolvedValue(null);
    mockProjectConnections.policyForThread.mockReset();
    mockProjectConnections.assertExecutionLocation.mockReset();
    mockProjectConnections.assertCopyOwnership.mockReset();
    mockProjectConnections.policyForThread.mockImplementation(
      (_threadId: string, cwd: string) =>
        mockProjectConnections.policyForCwd(cwd) as unknown,
    );
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

  it('restores durable agent choices for the next turn without changing an already-running request', async () => {
    mockPreferences.forTurn.mockReturnValue({
      model: 'saved-model',
      effort: 'high',
      serviceTier: null,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
    await service.startTurn({ threadId: 't1', input: [] });
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        model: 'saved-model',
        effort: 'high',
        serviceTier: null,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      }),
    );
    mockPreferences.forTurn.mockReturnValue({ effort: 'low' });
    expect(mockCodex.request).toHaveBeenCalledTimes(1);
    await service.startTurn({ threadId: 't1', input: [], effort: 'medium' });
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({ effort: 'medium' }),
    );
  });

  it('applies saved administrator model choices while preserving project read-only restrictions', async () => {
    mockPreferences.forTurn.mockReturnValue({
      model: 'saved-model',
      effort: 'high',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    mockProjectConnections.policyForCwd.mockResolvedValue({
      projectId: 'p',
      config: {},
      readOnly: true,
      model: 'project-model',
      reasoningEffort: 'low',
    });
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
    await service.startTurn({ threadId: 't1', input: [] });
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        model: 'saved-model',
        effort: 'high',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }),
    );
  });

  it.each([
    [{ model: 'saved-model', effort: null }, 'saved-model', null],
    [{ model: 'saved-model' }, 'saved-model', null],
    [{ effort: 'high' }, 'project-model', 'high'],
    [{ model: null, effort: null, serviceTier: null }, 'project-model', 'low'],
  ])(
    'resolves only persisted administrator model choices above project defaults: %j',
    async (saved, model, effort) => {
      mockPreferences.forTurn.mockReturnValue(saved);
      mockProjectConnections.policyForCwd.mockResolvedValue({
        projectId: 'p',
        config: {},
        model: 'project-model',
        reasoningEffort: 'low',
      });
      mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
      await service.startTurn({
        threadId: 't1',
        input: [],
        model: 'request-model',
        effort: 'medium',
      });
      expect(mockCodex.request).toHaveBeenLastCalledWith(
        'turn/start',
        expect.objectContaining({ model, effort }),
      );
    },
  );

  it('does not dispatch any RPC if permission persistence is unconfirmed or failed', async () => {
    mockPreferences.forTurn.mockImplementation(() => {
      throw new Error('Agent permissions awaiting confirmation');
    });
    await expect(
      service.startTurn({ threadId: 't1', input: [] }),
    ).rejects.toThrow('awaiting confirmation');
    expect(mockCodex.request).not.toHaveBeenCalled();
  });

  it('merges global starting defaults with project tools without rewriting explicit approvals or affecting existing turns', async () => {
    const project = {
      projectId: 'new-project',
      readOnly: false,
      config: { mcp_servers: { mergeron_internal: { enabled: true } } },
    };
    mockProjectConnections.policyForCwd.mockResolvedValue(project);
    mockAgentDefaults.forNewAgent.mockResolvedValue({
      sandbox: 'workspace-write',
      config: { sandbox_workspace_write: { network_access: true } },
    });
    mockCodex.request.mockResolvedValue({
      thread: { id: 'new-agent', historyMode: 'paginated' },
    });
    await service.startThread({
      cwd: '/project',
      approvalPolicy: 'on-request',
      config: { model_reasoning_effort: 'medium' },
    });
    expect(mockCodex.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        config: {
          sandbox_workspace_write: { network_access: true },
          model_reasoning_effort: 'medium',
          mcp_servers: project.config.mcp_servers,
        },
      }),
    );
    expect(mockAgentDefaults.forNewAgent).toHaveBeenCalledOnce();
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn' } });
    await service.startTurn({
      threadId: 'existing-agent',
      cwd: '/project',
      input: [],
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    expect(mockAgentDefaults.forNewAgent).toHaveBeenCalledOnce();
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }),
    );
  });

  it('moves an owned unmaterialized agent without resume and uses its selected cwd on the first real turn', async () => {
    mockResumeRegistry.ensureOpened.mockResolvedValue({
      mode: 'writable',
      thread: { id: 't1' },
    });
    mockCodex.request.mockImplementation((method: string) => {
      if (method === 'thread/turns/list')
        return Promise.reject(
          new CodexRpcError(
            {
              code: -32600,
              message:
                'thread t1 is not materialized yet; thread/turns/list is unavailable before first user message',
            },
            { method },
          ),
        );
      return Promise.resolve({ turn: { id: 'first' } });
    });
    await expect(service.setThreadCwd('t1', '/copy')).resolves.toEqual(['t1']);
    expect(mockWorkspaceOverrides.setMany).toHaveBeenCalledWith(
      ['t1'],
      '/copy',
    );
    expect(
      mockCodex.request.mock.calls.some(
        ([method]) => method === 'thread/resume',
      ),
    ).toBe(false);
    mockWorkspaceOverrides.get.mockReturnValue('/copy');
    await service.startTurn({
      threadId: 't1',
      cwd: '/old',
      input: [{ type: 'text', text: 'Hello', text_elements: [] }],
    });
    expect(mockCodex.request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({ threadId: 't1', cwd: '/copy' }),
    );
    expect(
      mockCodex.request.mock.calls.filter(
        ([method]) => method === 'turn/start',
      ),
    ).toHaveLength(1);
  });

  it('still resumes a persisted empty history and refuses unknown errors or foreign ownership without saving a cwd', async () => {
    mockResumeRegistry.ensureOpened.mockResolvedValue({
      mode: 'writable',
      thread: { id: 't1' },
    });
    mockCodex.request.mockResolvedValue({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
    await service.setThreadCwd('t1', '/copy');
    expect(mockCodex.request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({ threadId: 't1', cwd: '/copy' }),
    );
    mockWorkspaceOverrides.setMany.mockClear();
    mockCodex.request.mockRejectedValue(
      new Error('no rollout found for thread id t1'),
    );
    await expect(service.setThreadCwd('t1', '/other')).rejects.toThrow(
      'no rollout',
    );
    expect(mockWorkspaceOverrides.setMany).not.toHaveBeenCalled();
    mockResumeRegistry.ensureOpened.mockResolvedValue({ mode: 'readOnly' });
    mockCodex.request.mockClear();
    await expect(service.setThreadCwd('t1', '/other')).rejects.toThrow(
      'owned by another client',
    );
    expect(mockCodex.request).not.toHaveBeenCalled();
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

  it('reapplies the conversation copy boundary on each turn and cannot escalate to full access', async () => {
    const copyPermissions = {
      writable: 'managed-own',
      readOnly: 'managed-read',
      baseProfile: ':workspace',
    };
    mockProjectConnections.policyForCwd.mockResolvedValue({
      projectId: 'p',
      readOnly: false,
      copyPermissions,
    });
    cachedPermissionProfile.mockReturnValue({
      activePermissionProfile: { id: 'managed-own' },
    });
    mockCodex.request.mockResolvedValue({ turn: { id: 'isolated-turn' } });
    await service.startTurn({
      threadId: 't1',
      input: [],
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'on-request',
    });
    expect(mockCodex.request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        permissions: 'managed-own',
        approvalPolicy: {
          granular: {
            sandbox_approval: false,
            rules: false,
            skill_approval: false,
            request_permissions: false,
            mcp_elicitations: true,
          },
        },
      }),
    );
    expect(mockCodex.request.mock.calls.at(-1)?.[1]).not.toHaveProperty(
      'sandboxPolicy',
    );
    expect(mockProjectConnections.assertCopyOwnership).toHaveBeenCalled();
    mockCodex.request.mockClear();
    cachedPermissionProfile.mockReturnValue({});
    await expect(
      service.startTurn({ threadId: 't1', input: [] }),
    ).rejects.toThrow('GIT_COPY_ISOLATION_UNAVAILABLE');
    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'turn/start',
      expect.anything(),
    );
  });

  it.each([
    { type: 'dangerFullAccess' },
    { type: 'readOnly', networkAccess: false },
  ] as const)(
    'records only acknowledged maximum isolation before admitting a named turn (%j)',
    async (sandboxPolicy) => {
      const copyPermissions = {
        writable: 'managed-own',
        readOnly: 'managed-read',
        baseProfile: ':workspace',
        writableCopyPath: '/workspaces/p/sources/.external/git/own',
        readOnlyRoots: ['/workspaces/p/sources/.external'],
      };
      mockProjectConnections.policyForCwd.mockResolvedValue({
        projectId: 'p',
        readOnly: false,
        copyPermissions,
      });
      cachedPermissionProfile.mockReturnValue({
        activePermissionProfile: { id: 'managed-own' },
      });
      const recordIsolation = vi.fn(),
        clearIsolation = vi.fn();
      const startTurn = vi.fn((send: () => Promise<unknown>) => send());
      Object.assign(service, {
        gitMutations: { recordIsolation, clearIsolation, startTurn },
      });
      mockCodex.request.mockResolvedValue({ turn: { id: 'isolated-turn' } });
      await service.startTurn({ threadId: 't1', input: [], sandboxPolicy });
      expect(recordIsolation).toHaveBeenCalledWith('t1', copyPermissions);
      expect(recordIsolation.mock.invocationCallOrder[0]).toBeLessThan(
        startTurn.mock.invocationCallOrder[0],
      );
      expect(startTurn).toHaveBeenCalledWith(expect.any(Function), 't1');
      cachedPermissionProfile.mockReturnValue({});
      recordIsolation.mockClear();
      startTurn.mockClear();
      await expect(
        service.startTurn({ threadId: 't1', input: [] }),
      ).rejects.toThrow('GIT_COPY_ISOLATION_UNAVAILABLE');
      expect(recordIsolation).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();
    },
  );

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

  it('reopens an existing thread after MCP connection replacement before dispatching a turn', async () => {
    const order: string[] = [];
    Object.assign(service, {
      connections: {
        assertOpen: vi.fn(),
        assertGeneration: vi.fn(),
        beforeTurn: vi
          .fn()
          .mockResolvedValue({ policy: null, restarted: true }),
      },
    });
    mockResumeRegistry.ensureOpened.mockImplementation(() => {
      order.push('resume');
      return Promise.resolve({});
    });
    mockCodex.request.mockImplementation(() => {
      order.push('turn');
      return Promise.resolve({ turn: { id: 'turn1' } });
    });
    await service.startTurn({ threadId: 't1', input: [] });
    expect(order).toEqual(['resume', 'turn']);
  });

  it('does not dispatch a turn when the project integration policy cannot be enforced', async () => {
    Object.assign(service, {
      connections: {
        assertOpen: vi.fn(),
        beforeTurn: vi
          .fn()
          .mockRejectedValue(new Error('Cannot establish idle')),
      },
    });
    await expect(
      service.startTurn({ threadId: 't1', input: [] }),
    ).rejects.toThrow('Cannot establish idle');
    expect(mockCodex.request).not.toHaveBeenCalled();
  });

  it.each(['workspaceWrite', 'readOnly', 'dangerFullAccess'])(
    'adds the scoped draft directory only to workspaceWrite, not %s permissions',
    async (type) => {
      const sandbox =
        type === 'workspaceWrite'
          ? {
              type,
              writableRoots: ['/code'],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : type === 'readOnly'
            ? { type, networkAccess: false }
            : { type };
      Object.assign(service, {
        documentPublication: {
          prepare: vi.fn().mockResolvedValue({
            draftDirectory: '/draft/scope',
            context: '',
            bind: vi.fn(),
            abort: vi.fn(),
          }),
        },
        settingsObserver: {
          readSecurityPolicy: () => ({ sandboxPolicy: sandbox }),
        },
      });
      mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
      await service.startTurn({ threadId: 't1', input: [] });
      const sent = mockCodex.request.mock.calls[0][1] as {
        sandboxPolicy?: unknown;
      };
      expect(sent.sandboxPolicy).toEqual(
        type === 'workspaceWrite'
          ? { ...sandbox, writableRoots: ['/code', '/draft/scope'] }
          : undefined,
      );
      const publication = (
        service as unknown as {
          documentPublication: { prepare: ReturnType<typeof vi.fn> };
        }
      ).documentPublication;
      expect(publication.prepare).toHaveBeenCalledWith('t1', undefined);
    },
  );

  it('does not send turn/start while the Git mutation gate refuses admission', async () => {
    const startTurn = vi.fn().mockRejectedValue(new Error('GIT_BUSY'));
    Object.assign(service, { gitMutations: { startTurn } });
    await expect(
      service.startTurn({ threadId: 't1', input: [] }),
    ).rejects.toThrow('GIT_BUSY');
    expect(startTurn).toHaveBeenCalledOnce();
    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'turn/start',
      expect.anything(),
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

  it('supplies current common instructions to new, existing and forked agents without changing input or security policy', async () => {
    const contexts = [
      'Default visual policy',
      'Administrator revision',
      'Explicitly disabled policy',
    ];
    const context = vi.fn(() => contexts.shift()!);
    Object.assign(service, { agentInstructions: { context } });
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
    const input = [
      { type: 'text' as const, text: 'Build my interface', text_elements: [] },
      { type: 'image' as const, url: 'https://example.invalid/mockup.png' },
    ];
    const sandboxPolicy = { type: 'readOnly' as const, networkAccess: false };
    for (const [index, threadId] of ['new', 'existing', 'fork'].entries()) {
      const expectedContext = [
        'Default visual policy',
        'Administrator revision',
        'Explicitly disabled policy',
      ][index];
      await service.startTurn({ threadId, input, sandboxPolicy });
      expect(mockCodex.request).toHaveBeenLastCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId,
          sandboxPolicy,
          input: [
            {
              type: 'text',
              text: expectedContext,
              text_elements: [],
            },
            ...input,
          ],
        }),
      );
      expect(mockBranches.attachPendingVersionTurn).toHaveBeenLastCalledWith(
        threadId,
        'turn1',
        'Build my interface [image]',
      );
    }
    expect(input).toHaveLength(2);
  });

  it('combines common, project and knowledge context without losing the user request', async () => {
    Object.assign(service, {
      agentInstructions: { context: () => 'Common instructions' },
    });
    mockKnowledge.contextForConversation.mockResolvedValue('Shared knowledge');
    mockProjectTools.context.mockResolvedValue('Project context');
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
    await service.startTurn({
      threadId: 't1',
      input: [{ type: 'text', text: 'My request', text_elements: [] }],
    });
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [
          {
            type: 'text',
            text: 'Common instructions\n\nProject context\n\nShared knowledge',
            text_elements: [],
          },
          { type: 'text', text: 'My request', text_elements: [] },
        ],
      }),
    );
  });

  it('refreshes project identity and catalog on every existing-conversation turn', async () => {
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
    mockProjectTools.context
      .mockResolvedValueOnce('Project: Tests 2; tasks: A')
      .mockResolvedValueOnce('Project: Renamed; tasks: A, B');
    const input = [
      { type: 'text' as const, text: 'List my tasks', text_elements: [] },
    ];
    await service.startTurn({
      threadId: 'existing-agent',
      cwd: '/code',
      input,
    });
    await service.startTurn({
      threadId: 'existing-agent',
      cwd: '/code',
      input,
    });
    expect(mockProjectTools.context).toHaveBeenCalledWith(
      'existing-agent',
      '/code',
    );
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [
          {
            type: 'text',
            text: 'Project: Renamed; tasks: A, B',
            text_elements: [],
          },
          ...input,
        ],
      }),
    );
    expect(input).toHaveLength(1);
  });

  it('keeps a readonly location readonly even when full access is requested', async () => {
    mockProjectConnections.policyForCwd.mockResolvedValue({
      projectId: 'p',
      config: {},
      readOnly: true,
    });
    mockCodex.request.mockResolvedValue({
      thread: { id: 't1', historyMode: 'paginated' },
    });
    await service.startThread({ cwd: '/copy', sandbox: 'danger-full-access' });
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'thread/start',
      expect.objectContaining({ sandbox: 'read-only' }),
    );
    mockCodex.request.mockClear();
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });
    await service.startTurn({
      threadId: 't1',
      cwd: '/copy',
      input: [],
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    expect(mockCodex.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }),
    );
  });

  it('does not dispatch when the final execution-location check detects revocation', async () => {
    mockProjectConnections.assertExecutionLocation.mockImplementation(() => {
      throw new Error('location revoked');
    });
    await expect(service.startThread({ cwd: '/copy' })).rejects.toThrow(
      'location revoked',
    );
    await expect(
      service.startTurn({ threadId: 't1', cwd: '/copy', input: [] }),
    ).rejects.toThrow('location revoked');
    expect(mockCodex.request).not.toHaveBeenCalled();
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

  function archiveDatabase() {
    const database = createTestDatabase();
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'Project',
        workspacePath: '/project',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values(
        ['root', 'child'].map((threadId) => ({
          threadId,
          projectId: 'p',
          workspacePath: '/project',
          createdAt: 1,
          updatedAt: 1,
        })),
      )
      .run();
    Object.assign(service, { db: database.db });
    mockBranches.listKnownTreeThreadIds.mockReturnValue(['root', 'child']);
    return database;
  }
  function asPerson(
    identity: Partial<PlatformIdentity>,
    action: () => Promise<unknown>,
  ) {
    return accessContext.run(
      {
        identity: {
          kind: 'person',
          personId: 'actor',
          name: 'Acting person',
          role: 'administrator',
          active: true,
          ...identity,
        },
        identities: {
          requireAdministrator: vi.fn(),
        } as unknown as IdentityService,
      },
      action,
    );
  }

  it('records the authenticated author and server timestamp for each archived member, then clears on restoration', async () => {
    const database = archiveDatabase();
    try {
      mockCodex.request.mockResolvedValue({ thread: { id: 'child' } });
      const start = Date.now();
      await asPerson({}, () => service.archiveThread('child'));
      const rows = database.db.select().from(projectAgentThreads).all();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          archivedByPersonId: 'actor',
          archivedByName: 'Acting person',
          archivedByType: 'person',
        });
        expect(row.archivedAt).toBeGreaterThanOrEqual(start);
      }
      await asPerson({}, () => service.unarchiveThread('child'));
      expect(
        database.db
          .select()
          .from(projectAgentThreads)
          .all()
          .every(
            (row) => row.archivedAt === null && row.archivedByPersonId === null,
          ),
      ).toBe(true);
      await asPerson({ personId: 'next', name: 'Next author' }, () =>
        service.archiveThread('root'),
      );
      expect(
        database.db
          .select()
          .from(projectAgentThreads)
          .all()
          .every((row) => row.archivedByPersonId === 'next'),
      ).toBe(true);
    } finally {
      database.sqlite.close();
    }
  });

  it('attributes impersonated actions to the real administrator and never marks failed archives successful', async () => {
    const database = archiveDatabase();
    try {
      mockCodex.request
        .mockRejectedValueOnce(new Error('root refused'))
        .mockResolvedValueOnce({});
      await expect(
        asPerson(
          {
            impersonation: {
              sessionId: 'session',
              administratorId: 'real-admin',
              administratorName: 'Real administrator',
              personId: 'viewed-person',
              personName: 'Viewed person',
              expiresAt: Date.now() + 60000,
            },
          },
          () => service.archiveThread('root'),
        ),
      ).rejects.toThrow('root refused');
      const rows = database.db.select().from(projectAgentThreads).all();
      expect(
        rows.find((row) => row.threadId === 'root')?.archivedAt,
      ).toBeNull();
      expect(rows.find((row) => row.threadId === 'child')).toMatchObject({
        archivedByPersonId: 'real-admin',
        archivedByName: 'Real administrator',
      });
    } finally {
      database.sqlite.close();
    }
  });

  it('labels service actions as technical and leaves legacy records unknown', async () => {
    const database = archiveDatabase();
    try {
      expect(
        database.db
          .select()
          .from(projectAgentThreads)
          .all()
          .every(
            (row) => row.archivedAt === null && row.archivedByName === null,
          ),
      ).toBe(true);
      mockCodex.request.mockResolvedValue({});
      await asPerson({ kind: 'service', personId: null, name: null }, () =>
        service.archiveThread('root'),
      );
      expect(
        database.db
          .select()
          .from(projectAgentThreads)
          .all()
          .every(
            (row) =>
              row.archivedByType === 'service' &&
              row.archivedByPersonId === null,
          ),
      ).toBe(true);
    } finally {
      database.sqlite.close();
    }
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

  it('rechecks background admission after asynchronous preparation and yields to foreground input', async () => {
    let release!: () => void;
    let yielded = false;
    service.onForegroundInput(() => {
      yielded = true;
    });
    mockKnowledge.contextForConversation.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    );
    mockCodex.request.mockResolvedValue({ turn: { id: 'human' } });
    const beforeSend = vi.fn();
    const scheduled = service
      .startTurn(
        { threadId: 't', input: [] },
        {
          assertIdle: () => {
            if (yielded) throw new Error('MONITOR_AGENT_BUSY');
          },
          beforeSend,
        },
      )
      .catch((error: Error) => error);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await service.startTurn({ threadId: 't', input: [] });
    release();
    expect(await scheduled).toMatchObject({ message: 'MONITOR_AGENT_BUSY' });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(mockCodex.request).toHaveBeenCalledTimes(1);
  });

  it('notifies observers for both human starts and steering, without letting an observer block the person', async () => {
    const listener = vi.fn(() => {
      throw new Error('Observer unavailable');
    });
    const unsubscribe = service.onForegroundInput(listener);
    mockCodex.request.mockResolvedValue({ turn: { id: 'human' } });
    await service.startTurn({ threadId: 't', input: [] });
    await service.steerTurn({
      threadId: 't',
      expectedTurnId: 'human',
      input: [],
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await service.startTurn({ threadId: 't', input: [] });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('counts a background dispatch only immediately before the native send', async () => {
    const order: string[] = [];
    mockCodex.request.mockImplementation(async () => {
      await Promise.resolve();
      order.push('send');
      return { turn: { id: 'background' } };
    });
    await service.startTurn(
      { threadId: 't', input: [] },
      {
        assertIdle: vi.fn(),
        beforeSend: () => {
          order.push('admitted');
        },
      },
    );
    expect(order).toEqual(['admitted', 'send']);
  });

  it('does not name an empty conversation after the internal scheduled-check prompt', async () => {
    mockMetadata.getHeldThread.mockReturnValue({
      id: 't',
      name: '',
      preview: '',
    });
    mockCodex.request.mockResolvedValue({ turn: { id: 'scheduled' } });
    await service.startTurn(
      {
        threadId: 't',
        input: [
          {
            type: 'text',
            text: '<mergeron_agent_monitor>internal context</mergeron_agent_monitor>',
            text_elements: [],
          },
        ],
      },
      { assertIdle: vi.fn(), beforeSend: vi.fn() },
    );
    expect(mockCodex.request).toHaveBeenCalledTimes(1);
    expect(mockCodex.request.mock.calls[0][0]).toBe('turn/start');
  });

  it('refreshes project tools under the person’s identity after steering a monitor without upgrading its policy', async () => {
    service.onForegroundInput(() => true);
    mockActiveFolders.resolveAgent.mockReturnValue('/project');
    mockProjectConnections.policyForThread.mockResolvedValue({
      projectId: 'p',
      readOnly: false,
    });
    mockSettings.readSecurityPolicy.mockReturnValue({
      sandboxPolicy: { type: 'readOnly' },
    });
    const lease = { bind: vi.fn(), abort: vi.fn() };
    mockInternalMcp.prepare.mockReturnValue(lease);
    mockCodex.request.mockResolvedValue({ turnId: 'now-human' });
    await service.steerTurn({
      threadId: 't',
      expectedTurnId: 'now-human',
      input: [],
    });
    expect(mockInternalMcp.prepare).toHaveBeenCalledWith('t', 'p', false);
    expect(lease.bind).toHaveBeenCalledWith('now-human');
    expect(lease.abort).not.toHaveBeenCalled();
    mockCodex.request.mockRejectedValueOnce(new Error('Stale turn'));
    await expect(
      service.steerTurn({ threadId: 't', expectedTurnId: 'stale', input: [] }),
    ).rejects.toThrow('Stale turn');
    expect(lease.abort).toHaveBeenCalledTimes(1);
  });
});
