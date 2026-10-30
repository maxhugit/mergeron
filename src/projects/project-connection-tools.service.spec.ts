/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- Async service doubles and asymmetric matchers. */
import { GitGateRefusal } from '../threads/git-mutation-gate.service';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { accessContext } from '../auth/access-context';
import { IdentityService } from '../auth/identity.service';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectAgentThreads,
  projectParticipants,
  projectAgentToolRequests,
  projectConnections,
  projectActivity,
} from '../database/schema';
import { ProjectLocationsService } from './project-locations.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import {
  WorkspaceCopiesService,
  type WorkspaceCopyView,
} from './workspace-copies.service';
import { WorkspaceGitService } from './workspace-git.service';
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import { ProjectConnectionToolsService } from './project-connection-tools.service';

describe('project connection agent tools', () => {
  let database: TestDatabase;
  let identities: IdentityService;
  let resources: WorkspaceResourcesService;
  let tools: ProjectConnectionToolsService;
  let connectionId: string;
  let own: WorkspaceCopyView[];
  const state = {
    head: 'a'.repeat(40),
    branch: 'feature/test',
    fingerprint: 'b'.repeat(64),
  };
  const git = {
    snapshot: vi.fn(),
    remoteBranches: vi.fn(),
    remoteFiles: vi.fn(),
    pullRequests: vi.fn(),
    pullRequest: vi.fn(),
    checks: vi.fn(),
    diff: vi.fn(),
    stagedDiff: vi.fn(),
    commits: vi.fn(),
    mergeStatus: vi.fn(),
    conflictFile: vi.fn(),
  };
  const createCopy =
    vi.fn<
      (
        projectId: string,
        connectionId: string,
        input: { agentThreadId: string; branch?: string },
        beforeCommit: () => unknown,
      ) => Promise<WorkspaceCopyView>
    >();
  const actions = {
    push: vi.fn(),
    createPullRequest: vi.fn(),
    updatePullRequest: vi.fn(),
    retargetPullRequest: vi.fn(),
    stageReview: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    commit: vi.fn(),
    createBranch: vi.fn(),
    retrieveBranch: vi.fn(),
    localBranchAction: vi.fn(),
    startMerge: vi.fn(),
    abortMerge: vi.fn(),
  };
  const as = <T>(person: string, run: () => T) =>
    accessContext.run(
      { identities, identity: identities.resolvePerson(person) },
      run,
    );
  const call = (
    input: Record<string, unknown>,
    active: () => void = () => {},
  ) => as('admin', () => tools.execute('p', 'agent', input, active));
  const publish = (extra: Record<string, unknown> = {}) => ({
    tool: 'publish_project_git',
    operation: 'push',
    connectionId,
    copyId: 'own',
    requestId: 'publish-1',
    userRequest: 'Please push this branch.',
    expectedHead: state.head,
    expectedBranch: state.branch,
    fingerprint: state.fingerprint,
    ...extra,
  });
  const prepare = (extra: Record<string, unknown> = {}) =>
    publish({
      tool: 'prepare_project_git',
      operation: 'stage_review',
      paths: ['README.md'],
      ...extra,
    });

  beforeEach(() => {
    vi.resetAllMocks();
    database = createTestDatabase();
    database.db
      .insert(people)
      .values(
        ['admin', 'reader'].map((id) => ({
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
      .values(
        ['p', 'other'].map((id) => ({
          id,
          name: id,
          workspacePath: `/workspaces/${id}`,
          createdAt: 1,
          updatedAt: 1,
        })),
      )
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'agent',
        projectId: 'p',
        workspacePath: '/workspaces/p',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectParticipants)
      .values({ projectId: 'p', personId: 'reader', createdAt: 1 })
      .run();
    identities = new IdentityService(database.db);
    resources = new WorkspaceResourcesService(
      database.db,
      new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'unit-key' }),
    );
    connectionId = as('admin', () =>
      resources.create('p', {
        name: 'Git project',
        type: 'git',
        address: 'https://github.com/example/private.git',
        accessMode: 'read_write',
        secret: { token: 'private-unit-token' },
      }),
    ).id;
    as('admin', () =>
      resources.create('other', {
        name: 'Other private repository',
        type: 'git',
        address: 'https://github.com/example/other.git',
      }),
    );
    own = [
      {
        id: 'own',
        sourceResourceId: connectionId,
        ownerThreadIds: ['agent'],
        localPath: '/workspaces/p/copy',
        accessMode: 'read_write',
        state: 'ready',
        branch: state.branch,
        revision: state.head,
      } as WorkspaceCopyView,
    ];
    git.snapshot.mockResolvedValue(state);
    git.remoteBranches.mockResolvedValue({
      items: [{ name: 'main', revision: state.head }],
    });
    git.remoteFiles.mockResolvedValue({
      content: 'untrusted repository content',
      ref: state.head,
    });
    actions.push.mockImplementation(
      async (_p, _c, _body, publisher: { assertActive: () => void }) => {
        publisher.assertActive();
        return { sha: state.head, branch: state.branch };
      },
    );
    actions.createPullRequest.mockResolvedValue({
      number: 2,
      url: 'https://github.com/example/private/pull/2',
      existing: false,
    });
    tools = new ProjectConnectionToolsService(
      database.db,
      new ProjectLocationsService(database.db),
      {
        list: () => own,
        create: createCopy,
      } as unknown as WorkspaceCopiesService,
      git as unknown as WorkspaceGitService,
      actions as unknown as WorkspaceGitActionsService,
    );
  });
  afterEach(() => {
    database.sqlite.close();
  });

  const create = (extra: Record<string, unknown> = {}) => ({
    tool: 'create_project_git_copy',
    connectionId,
    requestId: 'clone-1',
    ...extra,
  });
  const allowClone = () => {
    own = [];
    createCopy.mockImplementation(
      async (_project, _connection, input, beforeCommit) => {
        beforeCommit();
        const copy = {
          id: 'created-copy',
          sourceResourceId: connectionId,
          ownerThreadIds: [input.agentThreadId],
          localPath: '/workspaces/p/sources/.external/created-copy',
          branch: 'main',
          revision: state.head,
          state: 'ready',
        } as WorkspaceCopyView;
        own.push(copy);
        return copy;
      },
    );
  };
  it('creates and attaches a managed copy only to the bound conversation, independently of its active folder', async () => {
    allowClone();
    const result = await call(create({ branch: 'main' }));
    expect(createCopy).toHaveBeenCalledWith(
      'p',
      connectionId,
      { agentThreadId: 'agent', branch: 'main' },
      expect.any(Function),
    );
    expect(result).toMatchObject({
      id: 'created-copy',
      ownerThreadId: 'agent',
      activeFolderChanged: false,
    });
    expect(await call(create({ branch: 'main' }))).toEqual(result);
    expect(createCopy).toHaveBeenCalledTimes(1);
    await expect(call(create({ branch: 'other' }))).rejects.toThrow(
      'PROJECT_CONNECTION_REQUEST_CONFLICT',
    );
  });
  it.each([
    'agentThreadId',
    'ownerThreadId',
    'threadId',
    'projectId',
    'copyId',
    'path',
    'address',
    'secret',
    'command',
  ])('rejects caller-selected %s before cloning', async (field) => {
    allowClone();
    await expect(call(create({ [field]: 'other' }))).rejects.toThrow();
    expect(createCopy).not.toHaveBeenCalled();
  });
  it('refuses a second copy and never claims or uses the existing one implicitly', async () => {
    await expect(call(create())).rejects.toThrow('GIT_AGENT_COPY_EXISTS');
    expect(createCopy).not.toHaveBeenCalled();
  });
  it('requires an administrator, a current writable turn and an enabled project connection', async () => {
    allowClone();
    await expect(
      as('reader', () => tools.execute('p', 'agent', create(), () => {})),
    ).rejects.toThrow();
    await expect(
      call(create(), () => {
        throw new Error('NO_ACTIVE_TURN');
      }),
    ).rejects.toThrow('NO_ACTIVE_TURN');
    as('admin', () => resources.update('p', connectionId, { enabled: false }));
    await expect(call(create())).rejects.toThrow(
      'PROJECT_CONNECTION_UNAVAILABLE',
    );
    expect(createCopy).not.toHaveBeenCalled();
  });
  it('keeps an interrupted clone unconfirmed instead of creating a duplicate on retry', async () => {
    allowClone();
    createCopy.mockRejectedValue(new Error('WORKSPACE_GIT_CLONE_FAILED'));
    await expect(call(create())).rejects.toThrow('WORKSPACE_GIT_CLONE_FAILED');
    await expect(call(create())).rejects.toThrow('GIT_OUTCOME_UNKNOWN');
    expect(createCopy).toHaveBeenCalledTimes(1);
  });
  it('rechecks source and turn authorization immediately before ownership is committed', async () => {
    allowClone();
    createCopy.mockImplementation(async (_p, _c, _input, beforeCommit) => {
      as('admin', () =>
        resources.update('p', connectionId, { enabled: false }),
      );
      beforeCommit();
      throw new Error('Unreachable after revocation');
    });
    await expect(call(create())).rejects.toThrow(
      'PROJECT_CONNECTION_UNAVAILABLE',
    );
    expect(own).toEqual([]);
  });

  it.each([
    [
      'fetch_branch',
      'retrieveBranch',
      { name: 'main', revision: 'c'.repeat(40) },
    ],
    [
      'switch_branch',
      'localBranchAction',
      { name: 'work', revision: 'c'.repeat(40) },
    ],
    ['start_merge', 'startMerge', { revision: 'c'.repeat(40) }],
    [
      'continue_merge',
      'commit',
      { revision: 'c'.repeat(40), message: 'Resolve conflicts' },
    ],
    ['abort_merge', 'abortMerge', { revision: 'c'.repeat(40) }],
  ] as const)(
    'binds %s to the caller, observed copy and stable request',
    async (operation, method, fields) => {
      const args = {
        ...publish(),
        tool: 'prepare_project_git',
        operation,
        ...fields,
      };
      actions[method].mockResolvedValue({ confirmed: true });
      await expect(call(args)).resolves.toMatchObject({
        data: { confirmed: true },
      });
      await call(args);
      expect(actions[method]).toHaveBeenCalledTimes(1);
      const invocation = actions[method].mock.calls[0];
      expect(invocation.slice(0, 2)).toEqual(['p', 'own']);
      expect(invocation[2]).toMatchObject({
        agentThreadId: 'agent',
        fingerprint: state.fingerprint,
      });
      expect(invocation[3]).toMatchObject({
        threadId: 'agent',
        assertActive: expect.any(Function),
      });
      if (operation === 'fetch_branch') expect(invocation[4]).toBe(true);
      if (operation === 'continue_merge')
        expect(invocation[2]).toMatchObject({ mergeRevision: fields.revision });
    },
  );
  it('inspects conflicts only on its owned copy and rejects arbitrary commands and remote URLs', async () => {
    git.mergeStatus.mockResolvedValue({
      mergeHead: 'c'.repeat(40),
      conflicts: [],
    });
    const args = {
      tool: 'read_project_git',
      connectionId,
      copyId: 'own',
      operation: 'local_merge_status',
    };
    await expect(call(args)).resolves.toMatchObject({
      data: { mergeHead: 'c'.repeat(40) },
    });
    await expect(call({ ...args, copyId: 'foreign' })).rejects.toThrow(
      'GIT_COPY_OWNED',
    );
    for (const extra of [
      { address: 'https://evil.invalid/repo' },
      { command: 'fetch --all' },
      { force: true },
    ])
      await expect(
        call({
          ...publish(),
          tool: 'prepare_project_git',
          operation: 'fetch_branch',
          name: 'main',
          revision: 'c'.repeat(40),
          ...extra,
        }),
      ).rejects.toThrow();
    expect(actions.retrieveBranch).not.toHaveBeenCalled();
  });

  it('edits only explicitly supplied PR metadata with the observed update timestamp', async () => {
    const args = publish({
      operation: 'update_pull_request',
      number: 271,
      title: 'Updated title',
      description: 'Updated description',
      expectedUpdatedAt: '2026-10-30T12:00:00Z',
    });
    actions.updatePullRequest.mockResolvedValue({ updated: true });
    await expect(call(args)).resolves.toMatchObject({
      data: { updated: true },
    });
    expect(actions.updatePullRequest).toHaveBeenCalledWith(
      'p',
      'own',
      expect.objectContaining({
        number: 271,
        title: 'Updated title',
        expectedUpdatedAt: args.expectedUpdatedAt,
      }),
      expect.objectContaining({ threadId: 'agent' }),
    );
    await expect(
      call({ ...args, requestId: 'bad-update', expectedUpdatedAt: undefined }),
    ).rejects.toThrow();
    for (const extra of [
      { base: 'main' },
      { draft: false },
      { expectedBase: 'main' },
      { expectedPullRequestHead: 'c'.repeat(40) },
    ])
      await expect(
        call({ ...args, requestId: 'bad-update-fields', ...extra }),
      ).rejects.toThrow();
    expect(actions.updatePullRequest).toHaveBeenCalledOnce();
  });

  it('creates a separate branch from an observed fetched reference instead of silently using HEAD', async () => {
    actions.createBranch.mockResolvedValue({ branch: 'new-work' });
    await call({
      ...publish(),
      tool: 'prepare_project_git',
      operation: 'create_branch',
      name: 'new-work',
      startRef: 'refs/remotes/mergeron/main',
      revision: 'c'.repeat(40),
    });
    expect(actions.createBranch).toHaveBeenCalledWith(
      'p',
      'own',
      expect.objectContaining({
        name: 'new-work',
        startRef: 'refs/remotes/mergeron/main',
        startRevision: 'c'.repeat(40),
        checkout: true,
      }),
      expect.objectContaining({ threadId: 'agent' }),
    );
  });

  it('allows the same requestId to retry a definitive gate refusal, but not an uncertain dispatched outcome', async () => {
    actions.stage
      .mockRejectedValueOnce(new GitGateRefusal('GIT_BUSY'))
      .mockResolvedValueOnce({ prepared: true });
    const args = prepare({
      operation: 'stage',
      reviewFingerprint: 'c'.repeat(64),
    });
    await expect(call(args)).rejects.toThrow('GIT_BUSY');
    await expect(call(args)).resolves.toMatchObject({
      data: { prepared: true },
    });
    expect(actions.stage).toHaveBeenCalledTimes(2);
    await expect(call(args)).resolves.toMatchObject({
      data: { prepared: true },
    });
    expect(actions.stage).toHaveBeenCalledTimes(2);
    actions.stage.mockRejectedValueOnce(
      new Error('connection lost after dispatch'),
    );
    const uncertain = { ...args, requestId: 'uncertain-stage' };
    await expect(call(uncertain)).rejects.toThrow('connection lost');
    await expect(call(uncertain)).rejects.toThrow('GIT_OUTCOME_UNKNOWN');
  });

  it('can inspect the entire frozen staged index rather than confusing it with working changes', async () => {
    git.stagedDiff.mockResolvedValue({
      fingerprint: state.fingerprint,
      diff: 'reviewed staged patch',
    });
    const result = await call({
      tool: 'read_project_git',
      connectionId,
      copyId: 'own',
      operation: 'local_staged_diff',
    });
    expect(result).toMatchObject({
      data: { fingerprint: state.fingerprint, diff: 'reviewed staged patch' },
      untrustedContent: true,
    });
    expect(git.stagedDiff).toHaveBeenCalledWith('p', 'own', undefined);
    await expect(
      call({
        tool: 'read_project_git',
        connectionId,
        copyId: 'foreign',
        operation: 'local_staged_diff',
      }),
    ).rejects.toThrow('GIT_COPY_OWNED');
  });
  it('reviews selected files, binds preparation to the caller, and journals retry results', async () => {
    actions.stageReview.mockResolvedValue({
      reviewFingerprint: 'c'.repeat(64),
      files: [],
    });
    const review = await call(prepare());
    expect(review).toMatchObject({
      operation: 'stage_review',
      untrustedContent: true,
    });
    expect(actions.stageReview).toHaveBeenCalledWith(
      'p',
      'own',
      expect.objectContaining({ agentThreadId: 'agent', paths: ['README.md'] }),
    );
    expect(await call(prepare())).toEqual(review);
    expect(actions.stageReview).toHaveBeenCalledTimes(1);
    await expect(call(prepare({ paths: ['other.md'] }))).rejects.toThrow(
      'PROJECT_CONNECTION_REQUEST_CONFLICT',
    );
  });
  it.each(['stage', 'unstage', 'commit', 'create_branch'] as const)(
    'dispatches %s only through a bound preparer capability',
    async (operation) => {
      actions[
        operation === 'create_branch' ? 'createBranch' : operation
      ].mockResolvedValue({ done: true });
      const args: Record<string, unknown> = prepare({
        operation,
        paths: undefined,
      });
      delete args.paths;
      if (operation === 'stage' || operation === 'unstage')
        Object.assign(args, { paths: ['README.md'] });
      if (operation === 'stage')
        Object.assign(args, { reviewFingerprint: 'c'.repeat(64) });
      if (operation === 'commit')
        Object.assign(args, { message: 'Update docs' });
      if (operation === 'create_branch')
        Object.assign(args, { name: 'docs/update' });
      await call(args);
      expect(
        actions[operation === 'create_branch' ? 'createBranch' : operation],
      ).toHaveBeenCalledWith(
        'p',
        'own',
        expect.objectContaining({
          agentThreadId: 'agent',
          fingerprint: state.fingerprint,
        }),
        expect.objectContaining({
          threadId: 'agent',
          assertActive: expect.any(Function),
        }),
      );
    },
  );
  it('rejects preparation for readers, other copies, stale states and unknown fields', async () => {
    await expect(
      as('reader', () => tools.execute('p', 'agent', prepare(), () => {})),
    ).rejects.toThrow();
    await expect(call(prepare({ copyId: 'foreign' }))).rejects.toThrow(
      'GIT_COPY_OWNED',
    );
    await expect(
      call(prepare({ expectedHead: 'd'.repeat(40) })),
    ).rejects.toThrow('GIT_STALE');
    for (const fields of [
      { authorName: 'spoof' },
      { address: 'https://evil.invalid' },
      { operation: 'reset' },
      { command: 'git add .' },
      {
        operation: 'commit',
        paths: undefined,
        message: 'x',
        authorEmail: 'spoof@example.com',
      },
    ])
      await expect(call(prepare(fields))).rejects.toThrow();
    expect(actions.stageReview).not.toHaveBeenCalled();
  });

  it('discovers only this project, without endpoints, secrets, diagnostics or other agents’ copy paths', async () => {
    own.push({
      ...own[0],
      id: 'other-copy',
      ownerThreadIds: ['other-agent'],
      localPath: '/private/other-copy',
    });
    const result = await call({ tool: 'list_project_connections' });
    expect(result).toMatchObject({
      total: 1,
      items: [
        {
          id: connectionId,
          protocol: 'git',
          copies: [{ id: 'own', localPath: '/workspaces/p/copy' }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-unit-token|encryptedValue|authTag|github.com|other-copy|Other private/,
    );
    expect(
      await call({ tool: 'list_project_connections', query: 'missing' }),
    ).toMatchObject({ total: 0, items: [] });
    expect(
      await call({ tool: 'list_project_connections', offset: 50 }),
    ).toMatchObject({ total: 1, items: [] });
  });
  it('uses configured Git credentials through the existing service, not a caller-supplied URL', async () => {
    expect(
      await call({
        tool: 'read_project_git',
        connectionId,
        operation: 'files',
        path: 'README.md',
        ref: state.head,
      }),
    ).toMatchObject({
      untrustedContent: true,
      data: { content: 'untrusted repository content' },
    });
    expect(git.remoteFiles).toHaveBeenCalledWith(
      'p',
      connectionId,
      'README.md',
      state.head,
    );
    await expect(
      call({
        tool: 'read_project_git',
        connectionId,
        operation: 'branches',
        address: 'https://attacker.invalid',
      }),
    ).rejects.toThrow();
    await expect(
      call({ tool: 'list_project_connections', projectId: 'other' }),
    ).rejects.toThrow();
  });
  it('inspects only its own copy and validates operation-specific fields', async () => {
    expect(
      await call({
        tool: 'read_project_git',
        connectionId,
        operation: 'local_status',
        copyId: 'own',
      }),
    ).toMatchObject({ data: state });
    await expect(
      call({
        tool: 'read_project_git',
        connectionId,
        operation: 'local_status',
        copyId: 'other',
      }),
    ).rejects.toThrow('GIT_COPY_OWNED');
    await expect(
      call({ tool: 'read_project_git', connectionId, operation: 'checks' }),
    ).rejects.toThrow();
    await expect(
      call({
        tool: 'read_project_git',
        connectionId,
        operation: 'branches',
        path: 'wrong',
      }),
    ).rejects.toThrow();
  });
  it('rejects missing authentication, wrong binding, revoked membership and disabled connections', async () => {
    await expect(
      tools.execute(
        'p',
        'agent',
        { tool: 'list_project_connections' },
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      as('admin', () =>
        tools.execute(
          'other',
          'agent',
          { tool: 'list_project_connections' },
          () => {},
        ),
      ),
    ).rejects.toThrow();
    as('admin', () => resources.setEnabled('p', connectionId, false));
    await expect(
      call({ tool: 'read_project_git', connectionId, operation: 'branches' }),
    ).rejects.toThrow('PROJECT_CONNECTION_UNAVAILABLE');
    expect(git.remoteBranches).not.toHaveBeenCalled();
  });
  it('pushes once, records caller/request audit and returns the confirmed result on identical retry', async () => {
    const first = await call(publish());
    expect(first).toMatchObject({
      operation: 'push',
      data: { sha: state.head },
    });
    expect(await call(publish())).toEqual(first);
    expect(actions.push).toHaveBeenCalledTimes(1);
    expect(database.db.select().from(projectActivity).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'agent_connection_published',
          entityId: 'agent',
          actorPersonId: 'admin',
          details: expect.objectContaining({ requestId: 'publish-1' }),
        }),
      ]),
    );
    expect(JSON.stringify(first)).not.toContain('private-unit-token');
    await expect(call(publish({ expectedBranch: 'changed' }))).rejects.toThrow(
      'PROJECT_CONNECTION_REQUEST_CONFLICT',
    );
  });
  it('creates a PR only with required metadata and observed commit; does not merge, commit or stage', async () => {
    await expect(
      call(publish({ operation: 'create_pull_request' })),
    ).rejects.toThrow();
    const result = await call(
      publish({
        operation: 'create_pull_request',
        base: 'main',
        title: 'Change',
        draft: false,
      }),
    );
    expect(result).toMatchObject({ data: { number: 2 } });
    expect(actions.createPullRequest).toHaveBeenCalledWith(
      'p',
      'own',
      expect.objectContaining({
        agentThreadId: 'agent',
        confirmation: 'CREATE_PULL_REQUEST',
        head: state.head,
        address: 'https://github.com/example/private.git',
      }),
      expect.objectContaining({ threadId: 'agent' }),
    );
    expect(actions.push).not.toHaveBeenCalled();
  });
  it('fails closed on stale state, read-only source, another copy owner and non-administrator', async () => {
    await expect(
      call(publish({ expectedHead: 'c'.repeat(40) })),
    ).rejects.toThrow('GIT_STALE');
    await expect(
      as('reader', () => tools.execute('p', 'agent', publish(), () => {})),
    ).rejects.toThrow();
    own[0].ownerThreadIds = ['another'];
    await expect(call(publish())).rejects.toThrow('GIT_COPY_OWNED');
    own[0].ownerThreadIds = ['agent'];
    as('admin', () =>
      resources.update('p', connectionId, { accessMode: 'read_only' }),
    );
    await expect(call(publish())).rejects.toThrow('GIT_READ_ONLY');
    expect(actions.push).not.toHaveBeenCalled();
  });
  it('rechecks active authority and source immediately before publication', async () => {
    actions.push.mockImplementation(
      async (_p, _c, _body, publisher: { assertActive: () => void }) => {
        database.db
          .update(projectConnections)
          .set({ enabled: false })
          .where(eq(projectConnections.id, connectionId))
          .run();
        publisher.assertActive();
      },
    );
    await expect(call(publish())).rejects.toThrow('GIT_READ_ONLY');
  });
  it('does not automatically repeat an uncertain remote outcome', async () => {
    actions.push.mockRejectedValueOnce(new Error('GIT_OUTCOME_UNKNOWN'));
    await expect(call(publish())).rejects.toThrow('GIT_OUTCOME_UNKNOWN');
    await expect(call(publish())).rejects.toThrow('GIT_OUTCOME_UNKNOWN');
    expect(actions.push).toHaveBeenCalledTimes(1);
    expect(
      database.db.select().from(projectAgentToolRequests).all()[0].result,
    ).toBeNull();
  });
  it('retargets once using separate observed remote PR state and records the change', async () => {
    const input = publish({
      operation: 'retarget_pull_request',
      number: 267,
      base: 'main',
      expectedBase: 'feature/old',
      expectedPullRequestHead: 'c'.repeat(40),
    });
    actions.retargetPullRequest.mockResolvedValue({
      number: 267,
      base: 'main',
      unchanged: false,
    });
    const first = await call(input);
    expect(first).toMatchObject({
      operation: 'retarget_pull_request',
      data: { number: 267, base: 'main' },
    });
    expect(await call(input)).toEqual(first);
    expect(actions.retargetPullRequest).toHaveBeenCalledTimes(1);
    expect(actions.retargetPullRequest).toHaveBeenCalledWith(
      'p',
      'own',
      expect.objectContaining({
        confirmation: 'RETARGET_PULL_REQUEST',
        number: 267,
        base: 'main',
        expectedBase: 'feature/old',
        expectedPullRequestHead: 'c'.repeat(40),
        head: state.head,
      }),
      expect.objectContaining({ threadId: 'agent' }),
    );
    expect(actions.createPullRequest).not.toHaveBeenCalled();
    expect(actions.push).not.toHaveBeenCalled();
    expect(database.db.select().from(projectActivity).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            number: 267,
            base: 'main',
            expectedBase: 'feature/old',
          }),
        }),
      ]),
    );
    await expect(call({ ...input, base: 'develop' })).rejects.toThrow(
      'PROJECT_CONNECTION_REQUEST_CONFLICT',
    );
  });
  it('rejects incomplete or mixed retarget fields before dispatch', async () => {
    const input = publish({
      operation: 'retarget_pull_request',
      number: 267,
      base: 'main',
      expectedBase: 'old',
      expectedPullRequestHead: 'c'.repeat(40),
    });
    for (const field of [
      'number',
      'base',
      'expectedBase',
      'expectedPullRequestHead',
    ]) {
      const invalid: Record<string, unknown> = { ...input };
      delete invalid[field];
      await expect(call(invalid)).rejects.toThrow();
    }
    for (const extra of [
      { title: 'ignored?' },
      { draft: false },
      { description: 'ignored?' },
      { number: 0 },
      { expectedPullRequestHead: 'invalid' },
      { expectedUpdatedAt: '2026-10-30T12:00:00Z' },
    ])
      await expect(call({ ...input, ...extra })).rejects.toThrow();
    expect(actions.retargetPullRequest).not.toHaveBeenCalled();
  });
  it('requires administrator write access, ownership and fresh local state for retargeting', async () => {
    const input = publish({
      operation: 'retarget_pull_request',
      number: 267,
      base: 'main',
      expectedBase: 'old',
      expectedPullRequestHead: 'c'.repeat(40),
    });
    await expect(
      as('reader', () => tools.execute('p', 'agent', input, () => {})),
    ).rejects.toThrow();
    await expect(
      call({ ...input, expectedHead: 'd'.repeat(40) }),
    ).rejects.toThrow('GIT_STALE');
    own[0].ownerThreadIds = ['another'];
    await expect(call(input)).rejects.toThrow('GIT_COPY_OWNED');
    own[0].ownerThreadIds = ['agent'];
    as('admin', () =>
      resources.update('p', connectionId, { accessMode: 'read_only' }),
    );
    await expect(call(input)).rejects.toThrow('GIT_READ_ONLY');
    expect(actions.retargetPullRequest).not.toHaveBeenCalled();
  });
});
