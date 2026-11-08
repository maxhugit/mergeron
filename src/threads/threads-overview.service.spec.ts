/** Overview semantics operate on complete shared metadata before pagination. */
import { resolve } from 'node:path';
import { ThreadsOverviewService } from './threads-overview.service';
import {
  ThreadMetadataService,
  type ThreadMetadataEntry,
} from './thread-metadata.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { makeThreadFixture } from './threads.testing';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { projects, projectAgentThreads } from '../database/schema';
import { accessContext } from '../auth/access-context';

function entry(
  id: string,
  parent: string | null = null,
  cwd = '/root',
  archived = false,
  updatedAt = 1,
): ThreadMetadataEntry {
  return {
    archived,
    thread: makeThreadFixture({
      id,
      forkedFromId: parent,
      cwd,
      updatedAt,
      createdAt: 1,
      name: id,
      preview: id,
    }),
  };
}

describe('ThreadsOverviewService', () => {
  let entries: ThreadMetadataEntry[];
  const freshness = {
    generation: 1,
    refreshedAt: 100,
    stale: false,
    refreshing: false,
  };
  const listEdges = vi.fn();
  const listPending = vi.fn();
  const listActiveMembers = vi.fn();
  let service: ThreadsOverviewService;
  let database: TestDatabase;
  afterEach(() => database.sqlite.close());
  beforeEach(() => {
    database = createTestDatabase();
    entries = [];
    listEdges.mockReturnValue([]);
    listPending.mockReturnValue([]);
    listActiveMembers.mockReturnValue(new Map());
    service = new ThreadsOverviewService(
      {
        read: () => Promise.resolve({ entries, freshness }),
      } as unknown as ThreadMetadataService,
      { listEdges } as unknown as ConversationBranchMutationsService,
      { listActiveMembers } as unknown as ConversationBranchesService,
      { listPending } as unknown as PendingApprovalsService,
      { applyToThreads: (threads: unknown[]) => threads } as never,
      database.db,
    );
  });

  it('focuses by registered membership across folders before folding and pagination', async () => {
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'P',
        workspacePath: '/root',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projects)
      .values({
        id: 'other-project',
        name: 'Other',
        workspacePath: '/other-project',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'foreign',
        projectId: 'other-project',
        workspacePath: '/root',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values(
        ['agent', 'branch', 'second', 'archived'].map((threadId) => ({
          threadId,
          projectId: 'p',
          workspacePath: '/root',
          createdAt: 1,
          updatedAt: 1,
        })),
      )
      .run();
    entries = [
      entry('foreign', null, '/root'),
      entry(
        'agent',
        null,
        '/root/.mergeron-system/livrables/document',
        false,
        10,
      ),
      entry('branch', 'agent', '/another/reference'),
      entry('second', null, '/elsewhere'),
      entry('archived', null, '/root', true),
    ];
    const first = await service.listOverview({ projectId: 'p', limit: 1 });
    expect(first.data).toHaveLength(1);
    expect(first.data[0].memberThreadIds.sort()).toEqual(['agent', 'branch']);
    expect(first.nextCursor).toBe('1');
    const second = await service.listOverview({
      projectId: 'p',
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.data[0].thread.id).toBe('second');
    expect(second.nextCursor).toBeNull();
    expect(
      (await service.listOverview({ projectId: 'p', archived: true })).data.map(
        (row) => row.thread.id,
      ),
    ).toEqual(['archived']);
    expect((await service.listOverview({ projectId: 'missing' })).data).toEqual(
      [],
    );
  });

  it('requires project access and still applies thread visibility in focus', async () => {
    const requireProject = vi.fn(() => {
      throw Error('project denied');
    });
    const identities = { requireProject, canReadThread: vi.fn(() => true) };
    await expect(
      accessContext.run(
        { identity: {} as never, identities: identities as never },
        () => service.listOverview({ projectId: 'private' }),
      ),
    ).rejects.toThrow('project denied');
    expect(requireProject).toHaveBeenCalledWith({}, 'private');
    database.db
      .insert(projects)
      .values({
        id: 'p',
        name: 'P',
        workspacePath: '/root',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'hidden',
        projectId: 'p',
        workspacePath: '/root',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    entries = [entry('hidden')];
    identities.requireProject = vi.fn();
    identities.canReadThread.mockReturnValue(false);
    const result = await accessContext.run(
      { identity: {} as never, identities: identities as never },
      () => service.listOverview({ projectId: 'p' }),
    );
    expect(result.data).toEqual([]);
  });

  it('collapses before paging and lifts activity from every matching member', async () => {
    entries = [
      entry('root'),
      ...Array.from({ length: 30 }, (_, i) =>
        entry(`child-${i}`, 'root', '/root', false, i + 10),
      ),
      entry('other', null, '/root', false, 5),
    ];
    listActiveMembers.mockReturnValue(
      new Map([['root', { activeThreadId: 'child-0' }]]),
    );
    const result = await service.listOverview({
      limit: 1,
      sortKey: 'updated_at',
    });
    expect(result.data[0]).toMatchObject({
      thread: { id: 'root', updatedAt: 39 },
      openThreadId: 'child-0',
      latestActivityAt: 39,
    });
    expect(result.data[0].memberThreadIds).toHaveLength(31);
    expect(result.nextCursor).toBe('1');
    expect(result.freshness).toBe(freshness);
    expect(
      (
        await service.listOverview({
          cursor: '1',
          limit: 1,
          sortKey: 'updated_at',
        })
      ).data[0].thread.id,
    ).toBe('other');
  });

  it('keeps filtered siblings separate when their root is outside the workspace', async () => {
    entries = [
      entry('root'),
      entry('left', 'root', '/branch'),
      entry('right', 'root', '/branch'),
    ];
    const result = await service.listOverview({ cwd: '/branch' });
    expect(result.data.map((row) => row.thread.id).sort()).toEqual([
      'left',
      'right',
    ]);
    expect(
      result.data.every(
        (row) =>
          row.treeRootThreadId === 'root' && row.memberThreadIds.length === 1,
      ),
    ).toBe(true);
  });

  it('walks through archived ancestors without displaying them in the active view', async () => {
    entries = [entry('root', null, '/root', true), entry('child', 'root')];
    expect((await service.listOverview({})).data[0]).toMatchObject({
      thread: { id: 'child' },
      treeRootThreadId: 'root',
    });
    expect(
      (await service.listOverview({ archived: true })).data[0],
    ).toMatchObject({
      thread: { id: 'root' },
      memberThreadIds: ['root'],
      hasBranchDescendants: true,
    });
  });

  it('preserves literal case-sensitive name OR preview search and relative cwd matching', async () => {
    const row = entry('id', null, resolve('.'));
    row.thread.name = 'Alpha_BETA % café';
    row.thread.preview = 'OriginalPrompt';
    entries = [row];
    expect(
      (await service.listOverview({ searchTerm: 'Alpha_', cwd: '.' })).data,
    ).toHaveLength(1);
    expect(
      (await service.listOverview({ searchTerm: 'OriginalPrompt' })).data,
    ).toHaveLength(1);
    expect((await service.listOverview({ searchTerm: 'alpha' })).data).toEqual(
      [],
    );
    expect((await service.listOverview({ searchTerm: 'Alpha%' })).data).toEqual(
      [],
    );
  });

  it('orders creation by the representative and excludes a filtered active pointer', async () => {
    entries = [
      entry('root'),
      entry('child', 'root', '/elsewhere'),
      entry('other'),
    ];
    entries[1].thread.createdAt = 100;
    entries[2].thread.createdAt = 50;
    listActiveMembers.mockReturnValue(
      new Map([['root', { activeThreadId: 'child' }]]),
    );
    const rows = (
      await service.listOverview({ sortKey: 'created_at', cwd: '/root' })
    ).data;
    expect(rows.map((row) => row.thread.id)).toEqual(['other', 'root']);
    expect(rows[1].openThreadId).toBe('root');
  });

  it('aggregates waiting state and local pending counts over the complete filtered group', async () => {
    entries = [
      entry('root'),
      entry('running', 'root'),
      entry('waiting', 'root'),
    ];
    entries[1].thread.status = { type: 'active', activeFlags: [] };
    entries[2].thread.status = {
      type: 'active',
      activeFlags: ['waitingOnUserInput'],
    };
    listPending.mockReturnValue([{ threadId: 'waiting' }]);
    expect((await service.listOverview({})).data[0]).toMatchObject({
      running: false,
      waitingOnApproval: true,
      waitingOnUserInput: true,
      pendingApprovalCount: 1,
    });
  });

  it('retains local parent precedence over an upstream relationship', async () => {
    entries = [entry('root'), entry('child', 'external')];
    listEdges.mockReturnValue([
      { childThreadId: 'child', parentThreadId: 'root' },
    ]);
    expect((await service.listOverview({})).data).toHaveLength(1);
  });
});
