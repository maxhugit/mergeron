import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectResources,
  projectDeliverables,
  projectDeliverableDocuments,
  deliverableDocumentOrganizations as organizations,
  deliverableDocumentLabelJobs as jobs,
  projectAgentThreads,
} from '../database/schema';
import { IdentityService } from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import { DocumentOrganizationService } from './document-organization.service';
import type { DeliverablesService } from './deliverables.service';
let database: TestDatabase,
  service: DocumentOrganizationService,
  identities: IdentityService;
type ModelInput = {
  labels: Array<{ id: string; name: string }>;
  documents: Array<{ id: string; name: string; format: string }>;
};
const now = Date.now();
function asAdmin<T>(fn: () => T) {
  return accessContext.run(
    { identity: identities.resolvePerson('admin'), identities },
    fn,
  );
}
function read() {
  return asAdmin(() => service.read('p', 'r', 'd'));
}
function create(name = 'Sources') {
  return asAdmin(() =>
    service.createLabel('p', 'r', 'd', {
      name,
      expectedRevision: read().revision,
    }),
  );
}
function assign(doc = 'one', ids = read().labels.map((l) => l.id)) {
  return asAdmin(() =>
    service.assign('p', 'r', 'd', doc, {
      expectedRevision: read().revision,
      expectedVersion: 1,
      labelIds: ids,
    }),
  );
}
function response(input: { prompt: string }) {
  const p = JSON.parse(input.prompt) as ModelInput;
  return JSON.stringify({
    labels: p.labels,
    documents: p.documents.map((d: { id: string }) => ({
      id: d.id,
      labelIds: p.labels.map((l: { id: string }) => l.id),
    })),
    reason: 'Classement de la source',
  });
}
beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values([
      {
        id: 'admin',
        reference: 'admin',
        name: 'Admin',
        role: 'administrator',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'other',
        reference: 'other',
        name: 'Other',
        role: 'administrator',
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'P',
      workspacePath: '/workspaces/p',
      workspaceLayoutVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectResources)
    .values({
      id: 'r',
      projectId: 'p',
      name: 'Deliverables',
      type: 'deliverable_board',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectDeliverables)
    .values({
      id: 'd',
      resourceId: 'r',
      title: 'Test',
      lifecycleStatus: 'in_constitution',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectDeliverableDocuments)
    .values(
      ['one', 'two'].map((id) => ({
        id,
        deliverableId: 'd',
        name: id + '.txt',
        format: 'txt',
        sourcePath: '/workspaces/p/livrables/d/' + id + '.txt',
        currentVersionNumber: 1,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .run();
  identities = new IdentityService(database.db);
  const deliverables = {
    get: () =>
      database.db
        .select()
        .from(projectDeliverables)
        .where(eq(projectDeliverables.id, 'd'))
        .get(),
    board: () => ({
      deliverables: [
        {
          ...database.db.select().from(projectDeliverables).get(),
          documents: database.db
            .select()
            .from(projectDeliverableDocuments)
            .all()
            .map((d) => ({ ...d, versions: [] })),
        },
      ],
    }),
  } as unknown as DeliverablesService;
  service = new DocumentOrganizationService(
    database.db,
    deliverables,
    identities,
  );
  service.onModuleInit();
  service.setRunner(
    vi.fn(async (input: { prompt: string }) => {
      await Promise.resolve();
      return response(input);
    }),
  );
});
afterEach(() => {
  service.onModuleDestroy();
  database.sqlite.close();
});
it('persists labels and rejects duplicate names and stale revisions', () => {
  expect(create().labels).toHaveLength(1);
  expect(read().automaticEnabled).toBe(true);
  expect(() =>
    asAdmin(() =>
      service.createLabel('p', 'r', 'd', {
        name: 'sources',
        expectedRevision: 1,
      }),
    ),
  ).toThrow();
  expect(() =>
    asAdmin(() =>
      service.createLabel('p', 'r', 'd', {
        name: 'Other',
        expectedRevision: 0,
      }),
    ),
  ).toThrow();
});
it('requires confirmation before deleting an assigned label and only removes its assignments', () => {
  create();
  assign();
  const { labels, revision } = read();
  expect(() =>
    asAdmin(() =>
      service.deleteLabel('p', 'r', 'd', labels[0].id, {
        expectedRevision: revision,
      }),
    ),
  ).toThrow();
  const result = asAdmin(() =>
    service.deleteLabel('p', 'r', 'd', labels[0].id, {
      expectedRevision: revision,
      confirmUnassign: true,
    }),
  );
  expect(result.labels).toEqual([]);
  expect(result.assignments.one).toEqual([]);
  expect(
    database.db.select().from(projectDeliverableDocuments).all(),
  ).toHaveLength(2);
});
it('supports multi-label assignments and rejects foreign documents, versions and label ids', () => {
  create();
  create('Compte rendu');
  expect(assign().assignments.one).toHaveLength(2);
  for (const body of [
    { labelIds: ['foreign'], expectedVersion: 1 },
    { labelIds: [], expectedVersion: 3 },
  ])
    expect(() =>
      asAdmin(() =>
        service.assign('p', 'r', 'd', 'one', {
          expectedRevision: read().revision,
          ...body,
        }),
      ),
    ).toThrow();
  expect(() =>
    asAdmin(() =>
      service.assign('p', 'r', 'd', 'foreign', {
        expectedRevision: read().revision,
        labelIds: [],
        expectedVersion: 1,
      }),
    ),
  ).toThrow();
});
it('proposes a complete organization from zero labels without applying it, then applies atomically', async () => {
  service.setRunner(() =>
    Promise.resolve(
      JSON.stringify({
        labels: [{ id: 'new-source', name: 'Sources' }],
        documents: [
          { id: 'one', labelIds: ['new-source'] },
          { id: 'two', labelIds: [] },
        ],
        reason: 'Une source',
      }),
    ),
  );
  const job = asAdmin(() => service.proposal('p', 'r', 'd'));
  await service.drain();
  expect(read().labels).toHaveLength(0);
  expect(read().jobs.find((j) => j.id === job.id)?.status).toBe('proposed');
  const result = asAdmin(() => service.apply('p', 'r', 'd', job.id));
  expect(result.labels[0].name).toBe('Sources');
  expect(result.assignments.one).toEqual(['new-source']);
  expect(() => asAdmin(() => service.apply('p', 'r', 'd', job.id))).toThrow();
});
it('rejects a proposal when a document changed while the model was working', async () => {
  service.setRunner(async (input) => {
    await Promise.resolve();
    database.db
      .update(projectDeliverableDocuments)
      .set({ currentVersionNumber: 2 })
      .where(eq(projectDeliverableDocuments.id, 'one'))
      .run();
    return response(input);
  });
  const job = asAdmin(() => service.proposal('p', 'r', 'd'));
  await service.drain();
  expect(read().jobs.find((j) => j.id === job.id)?.status).toBe('stale');
  expect(() => asAdmin(() => service.apply('p', 'r', 'd', job.id))).toThrow();
});
it('automatically classifies two documents independently without creating labels or versions', async () => {
  create();
  asAdmin(() => {
    service.enqueueAutomatic('p', 'r', 'd', 'one');
    service.enqueueAutomatic('p', 'r', 'd', 'two');
  });
  await service.drain();
  const result = read();
  expect(result.assignments.one).toEqual([result.labels[0].id]);
  expect(result.assignments.two).toEqual([result.labels[0].id]);
  expect(result.jobs.every((j) => j.status === 'applied')).toBe(true);
  expect(
    database.db
      .select()
      .from(projectDeliverableDocuments)
      .all()
      .map((d) => d.currentVersionNumber),
  ).toEqual([1, 1]);
});
it('refuses automatic taxonomy changes and preserves human organization on failure', async () => {
  create();
  service.setRunner(async (input) => {
    await Promise.resolve();
    const p = JSON.parse(input.prompt) as ModelInput;
    return JSON.stringify({
      labels: [...p.labels, { id: 'new-evil', name: 'New' }],
      documents: p.documents.map((d: { id: string }) => ({
        id: d.id,
        labelIds: [],
      })),
      reason: 'No',
    });
  });
  asAdmin(() => service.enqueueAutomatic('p', 'r', 'd', 'one'));
  await service.drain();
  expect(read().labels).toHaveLength(1);
  expect(read().jobs[0].status).toBe('failed');
  expect(read().assignments).toEqual({});
});
it('rechecks the authority which enabled automatic classification after inference', async () => {
  create();
  service.setRunner(async (input) => {
    await Promise.resolve();
    database.db
      .update(people)
      .set({ role: 'standard' })
      .where(eq(people.id, 'admin'))
      .run();
    return response(input);
  });
  asAdmin(() => service.enqueueAutomatic('p', 'r', 'd', 'one'));
  await service.drain();
  expect(database.db.select().from(jobs).get()?.status).toBe('failed');
  expect(database.db.select().from(organizations).get()?.assignments).toEqual(
    {},
  );
});
it('marks interrupted work as failed at restart rather than replaying it silently', () => {
  asAdmin(() => service.proposal('p', 'r', 'd'));
  service.onModuleInit();
  expect(read().jobs[0]).toMatchObject({
    status: 'failed',
    error: 'interrupted',
  });
});
it('rejects unknown, duplicate and missing document IDs from the model', () => {
  for (const documents of [
    [{ id: 'foreign', labelIds: [] }],
    [
      { id: 'one', labelIds: [] },
      { id: 'one', labelIds: [] },
    ],
    [],
  ])
    expect(() =>
      service.validate(
        JSON.stringify({ labels: [], documents, reason: '' }),
        ['one', 'two'],
        [],
        false,
      ),
    ).toThrow();
});
it('persists display independently for each authenticated person and agent', () => {
  database.db
    .insert(projectAgentThreads)
    .values(
      ['agent-a', 'agent-b'].map((threadId) => ({
        threadId,
        projectId: 'p',
        workspacePath: '/workspaces/p',
        createdAt: now,
        updatedAt: now,
      })),
    )
    .run();
  const admin = identities.resolvePerson('admin'),
    other = identities.resolvePerson('other');
  expect(identities.documentExplorerView(admin, 'agent-a', 'labels').mode).toBe(
    'labels',
  );
  expect(identities.documentExplorerView(admin, 'agent-b').mode).toBe('plain');
  expect(identities.documentExplorerView(other, 'agent-a').mode).toBe('plain');
  expect(() =>
    identities.documentExplorerView(admin, 'agent-a', 'invalid'),
  ).toThrow();
});
