/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- Async service doubles and asymmetric matchers. */
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
    checks: vi.fn(),
    diff: vi.fn(),
    stagedDiff: vi.fn(),
    commits: vi.fn(),
  };
  const actions = {
    push: vi.fn(),
    createPullRequest: vi.fn(),
    retargetPullRequest: vi.fn(),
    stageReview: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    commit: vi.fn(),
    createBranch: vi.fn(),
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
      { list: () => own } as unknown as WorkspaceCopiesService,
      git as unknown as WorkspaceGitService,
      actions as unknown as WorkspaceGitActionsService,
    );
  });
  afterEach(() => {
    database.sqlite.close();
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
