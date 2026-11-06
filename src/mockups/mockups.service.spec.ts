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
  conversationMockups,
  conversationMockupRevisions,
} from '../database/schema';
import { IdentityService } from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import type { FileUploadInput } from '../files/files.service';
import type { DeliverablesService } from '../deliverables/deliverables.service';
import { MockupsService } from './mockups.service';
import {
  MAX_MOCKUP_BYTES,
  MAX_MOCKUP_REVISIONS,
  MAX_PROJECT_MOCKUP_BYTES,
} from './mockup.schema';

describe('conversation mockups', () => {
  let database: TestDatabase,
    identities: IdentityService,
    service: MockupsService;
  let retained: {
    get: ReturnType<typeof vi.fn>;
    uploadDocuments: ReturnType<
      typeof vi.fn<DeliverablesService['uploadDocuments']>
    >;
  };
  const as = <T>(person: string, action: () => T) =>
    accessContext.run(
      { identity: identities.resolvePerson(person), identities },
      action,
    );
  const tool = (
    name: string,
    args: Record<string, unknown> = {},
    write = true,
  ) =>
    service.tool(
      'p',
      'agent',
      { tool: `project_mockup_${name}`, ...args },
      () => {},
      write,
    );
  const create = (requestId = 'create') =>
    tool('create', {
      requestId,
      title: 'Checkout',
      html: '<button>Simulated checkout</button>',
    });
  const reference = (result: unknown) =>
    (result as { reference: { id: string; revision: string; number: number } })
      .reference;
  beforeEach(() => {
    database = createTestDatabase();
    const now = Date.now();
    database.db
      .insert(people)
      .values(
        ['admin', 'reader', 'outsider'].map((id) => ({
          id,
          reference: id,
          name: id,
          role:
            id === 'admin' ? ('administrator' as const) : ('standard' as const),
          createdAt: now,
          updatedAt: now,
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
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    database.db
      .insert(projectParticipants)
      .values({ projectId: 'p', personId: 'reader', createdAt: now })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values([
        {
          threadId: 'agent',
          projectId: 'p',
          workspacePath: '/workspaces/p',
          createdAt: now,
          updatedAt: now,
        },
        {
          threadId: 'foreign',
          projectId: 'other',
          workspacePath: '/workspaces/other',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    identities = new IdentityService(database.db);
    retained = {
      get: vi.fn(),
      uploadDocuments: vi
        .fn()
        .mockResolvedValue({ files: [{ path: 'retained.html', size: 0 }] }),
    };
    service = new MockupsService(
      database.db,
      retained as unknown as DeliverablesService,
    );
  });
  afterEach(() => database.sqlite.close());
  it('creates, reads and updates immutable history with durable retry receipts', async () =>
    as('admin', async () => {
      const first = await create();
      const ref = reference(first);
      expect(await create()).toEqual(first);
      expect(
        reference(
          await tool('manage', {
            id: ref.id,
            baseRevision: ref.revision,
            requestId: 'v2',
            title: 'Checkout v2',
            html: '<button>Next</button>',
          }),
        ).number,
      ).toBe(2);
      const reopened = new MockupsService(
        database.db,
        retained as unknown as DeliverablesService,
      );
      expect(reopened.read('p', 'agent', ref.id, ref.revision).html).toContain(
        'Simulated checkout',
      );
      expect(
        reopened.read('p', 'agent', ref.id).history.map((r) => r.number),
      ).toEqual([1, 2]);
      expect(await tool('report', { id: ref.id })).not.toHaveProperty('html');
      expect(((await tool('list')) as { items: unknown[] }).items).toHaveLength(
        1,
      );
      await expect(
        tool('manage', {
          id: ref.id,
          baseRevision: ref.revision,
          requestId: 'conflict',
          title: 'Stale',
          html: 'stale',
        }),
      ).rejects.toThrow('MOCKUP_REVISION_CONFLICT');
      await expect(
        tool('create', {
          requestId: 'create',
          title: 'Different',
          html: 'different',
        }),
      ).rejects.toThrow('MOCKUP_REQUEST_CONFLICT');
    }));
  it('requires a live identity and refuses foreign project, conversation and revision access', async () => {
    await expect(create()).rejects.toThrow('MOCKUP_IDENTITY_REQUIRED');
    const ref = reference(await as('admin', create));
    expect(
      as('reader', () => service.read('p', 'agent', ref.id).reference.id),
    ).toBe(ref.id);
    expect(() =>
      as('outsider', () => service.read('p', 'agent', ref.id)),
    ).toThrow();
    expect(() =>
      as('admin', () => service.read('other', 'foreign', ref.id)),
    ).toThrow('MOCKUP_NOT_FOUND');
    expect(() =>
      as('admin', () => service.read('other', 'agent', ref.id)),
    ).toThrow('MOCKUP_NOT_FOUND');
    expect(() =>
      as('admin', () =>
        service.read(
          'p',
          'agent',
          ref.id,
          '00000000-0000-4000-8000-000000000000',
        ),
      ),
    ).toThrow('MOCKUP_REVISION_NOT_FOUND');
    await expect(
      as('admin', () =>
        tool('create', { requestId: 'readonly', title: 'x', html: 'x' }, false),
      ),
    ).rejects.toThrow('READ_ONLY');
    await expect(
      as('admin', () =>
        tool('create', {
          requestId: 'smuggle',
          title: 'x',
          html: 'x',
          projectId: 'other',
        }),
      ),
    ).rejects.toThrow();
  });
  it('bounds UTF-8 size, revision retention and total project bytes without deleting history', async () =>
    as('admin', async () => {
      await expect(
        tool('create', {
          requestId: 'large',
          title: 'Large',
          html: 'é'.repeat(MAX_MOCKUP_BYTES / 2 + 1),
        }),
      ).rejects.toThrow('MOCKUP_SIZE_LIMIT');
      const ref = reference(await create());
      database.db
        .update(conversationMockupRevisions)
        .set({ bytes: MAX_PROJECT_MOCKUP_BYTES })
        .run();
      await expect(create('overQuota')).rejects.toThrow(
        'MOCKUP_QUOTA_EXCEEDED',
      );
      database.db.update(conversationMockupRevisions).set({ bytes: 1 }).run();
      for (let n = 2; n <= MAX_MOCKUP_REVISIONS; n++)
        database.db
          .insert(conversationMockupRevisions)
          .values({
            id: `revision-${n}`,
            mockupId: ref.id,
            number: n,
            title: 'Retained',
            html: 'x',
            bytes: 1,
            authorName: 'admin',
            createdAt: n,
          })
          .run();
      await expect(
        tool('manage', {
          id: ref.id,
          baseRevision: ref.revision,
          requestId: 'overHistory',
          title: 'x',
          html: 'x',
        }),
      ).rejects.toThrow('MOCKUP_QUOTA_EXCEEDED');
      expect(service.read('p', 'agent', ref.id).history).toHaveLength(
        MAX_MOCKUP_REVISIONS,
      );
    }));
  it('cascades sources and revision history on permanent project deletion', async () =>
    as('admin', async () => {
      await create();
      database.db.delete(projects).where(eq(projects.id, 'p')).run();
      expect(database.db.select().from(conversationMockups).all()).toEqual([]);
      expect(
        database.db.select().from(conversationMockupRevisions).all(),
      ).toEqual([]);
    }));
  it('publishes only through the existing document version workflow and never duplicates uncertain writes', async () =>
    as('admin', async () => {
      const ref = reference(await create());
      const args = {
        id: ref.id,
        revision: ref.revision,
        resourceId: 'board',
        deliverableId: 'deliverable',
        requestId: 'save',
        userRequest: 'Save this mockup as a deliverable',
      };
      await tool('publish', args);
      await tool('publish', args);
      expect(retained.uploadDocuments).toHaveBeenCalledTimes(1);
      expect(retained.uploadDocuments.mock.calls[0].slice(0, 3)).toEqual([
        'p',
        'board',
        'deliverable',
      ]);
      retained.uploadDocuments.mockRejectedValueOnce(
        new Error('Uncertain transfer'),
      );
      await expect(
        tool('publish', { ...args, requestId: 'unknown' }),
      ).rejects.toThrow('Uncertain transfer');
      await expect(
        tool('publish', { ...args, requestId: 'unknown' }),
      ).rejects.toThrow('MOCKUP_PUBLICATION_UNCONFIRMED');
      expect(retained.uploadDocuments).toHaveBeenCalledTimes(2);
    }));
  it('saves the selected immutable source as a version of an existing deliverable document', async () =>
    as('admin', async () => {
      const ref = reference(await create());
      await tool('manage', {
        id: ref.id,
        baseRevision: ref.revision,
        requestId: 'revision2',
        title: 'Newer',
        html: '<p>Newer revision</p>',
      });
      let saved = '';
      retained.uploadDocuments.mockImplementationOnce(
        async (
          _p: string,
          _r: string,
          _d: string,
          uploads: AsyncIterable<FileUploadInput>,
          options: { beforeCommit?: () => void },
        ) => {
          options.beforeCommit?.();
          for await (const file of uploads)
            for await (const part of file.stream) saved += String(part);
          return { files: [] };
        },
      );
      await tool('publish', {
        id: ref.id,
        revision: ref.revision,
        resourceId: 'board',
        deliverableId: 'deliverable',
        documentId: 'document',
        expectedVersion: 3,
        requestId: 'version-save',
        userRequest: 'Save this approved revision as a new document version',
      });
      expect(saved).toBe('<button>Simulated checkout</button>');
      expect(retained.uploadDocuments.mock.calls[0][4]).toMatchObject({
        documentId: 'document',
        expectedVersion: 3,
        comment: 'Mockup revision 1',
      });
    }));
});
