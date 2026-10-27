import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { projects, projectKnowledgeProposals } from '../database/schema';
import { ProjectWorkspaceLayout } from '../projects/project-workspace-layout';
import {
  ProjectKnowledgeService,
  type KnowledgeSnapshot,
} from './project-knowledge.service';
import { KnowledgeProposalsService } from './knowledge-proposals.service';

let database: TestDatabase,
  root: string,
  knowledge: ProjectKnowledgeService,
  proposals: KnowledgeProposalsService,
  snapshot: KnowledgeSnapshot;
const source = {
  sourceType: 'agent' as const,
  threadId: 'thread',
  sourceId: 'turn',
};
function block(overrides: Record<string, unknown> = {}) {
  return (
    'Suggestion en attente.\n```webui-memory-proposal\n' +
    JSON.stringify({
      baseRevision: snapshot.revision,
      title: 'Retenir une décision',
      file: 'DECISIONS.md',
      operation: 'append',
      text: 'Utiliser les identifiants immuables.',
      ...overrides,
    }) +
    '\n```'
  );
}
function create() {
  return proposals.capture('p', source, block())!;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-proposals-'));
  database = createTestDatabase(path.join(root, 'database.sqlite'));
  const primary = await new ProjectWorkspaceLayout(database.db, root).prepare(
    'p',
  );
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Project',
      workspacePath: primary,
      workspaceLayoutVersion: 3,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  knowledge = new ProjectKnowledgeService(database.db);
  proposals = new KnowledgeProposalsService(database.db, knowledge);
  await knowledge.contextForProject('p');
  snapshot = await knowledge.read('p');
});
afterEach(async () => {
  database.sqlite.close();
  await fs.rm(root, { recursive: true, force: true });
});

it('records a pending proposal with source and date, without changing shared files', async () => {
  const proposal = create();
  expect(proposal).toMatchObject({
    status: 'pending',
    threadId: 'thread',
    sourceId: 'turn',
    sourceType: 'agent',
    version: 1,
  });
  expect(proposal.createdAt).toBeGreaterThan(0);
  expect((await knowledge.read('p')).files).toEqual(snapshot.files);
  expect(proposals.list('p').proposals).toHaveLength(1);
  expect(proposals.list('p').proposals[0]).not.toHaveProperty('baseFiles');
  expect(
    proposals.capture('p', { ...source, sourceId: 'another-turn' }, block()),
  ).toBeNull();
});

it('only applies an explicitly accepted proposal and records who accepted it', async () => {
  const proposal = create();
  const reviewed = await proposals.review(
    'p',
    proposal.id,
    { action: 'accept', version: 1 },
    'Maxime',
  );
  expect(reviewed).toMatchObject({
    status: 'accepted',
    reviewer: 'Maxime',
    version: 2,
  });
  expect((await knowledge.read('p')).files['DECISIONS.md']).toContain(
    'identifiants immuables',
  );
  expect((await knowledge.read('p')).files['AGENTS.md']).toBe(
    snapshot.files['AGENTS.md'],
  );
  await expect(
    proposals.review(
      'p',
      proposal.id,
      { action: 'accept', version: 2 },
      'Maxime',
    ),
  ).rejects.toThrow('already changed');
});

it('keeps proposed edits separate from shared memory until accepted', async () => {
  const proposal = create();
  const edited = await proposals.review(
    'p',
    proposal.id,
    { action: 'edit', version: 1, content: 'Texte corrigé' },
    'Maxime',
  );
  expect(edited.version).toBe(2);
  expect((await knowledge.read('p')).files).toEqual(snapshot.files);
  await expect(
    proposals.review(
      'p',
      proposal.id,
      { action: 'accept', version: 1 },
      'Other reviewer',
    ),
  ).rejects.toThrow('already changed');
  await proposals.review(
    'p',
    proposal.id,
    { action: 'accept', version: 2 },
    'Maxime',
  );
  expect((await knowledge.read('p')).files['DECISIONS.md']).toBe(
    'Texte corrigé',
  );
});

it('rejects without modifying files, and does not recreate a rejected duplicate', async () => {
  const proposal = create();
  expect(
    (
      await proposals.review(
        'p',
        proposal.id,
        { action: 'reject', version: 1 },
        'Maxime',
      )
    ).status,
  ).toBe('rejected');
  expect((await knowledge.read('p')).files).toEqual(snapshot.files);
  expect(proposals.capture('p', source, block())).toBeNull();
});

it('does not overwrite a newer shared document when accepting an old proposal', async () => {
  const proposal = create();
  await knowledge.save('p', {
    files: { ...snapshot.files, 'AGENTS.md': 'New rule from another editor' },
    revision: snapshot.revision,
  });
  await expect(
    proposals.review(
      'p',
      proposal.id,
      { action: 'accept', version: 1 },
      'Maxime',
    ),
  ).rejects.toThrow('changed since');
  expect(proposals.get('p', proposal.id).status).toBe('pending');
  expect((await knowledge.read('p')).files['AGENTS.md']).toBe(
    'New rule from another editor',
  );
});

it('serializes concurrent acceptance and rejection', async () => {
  const proposal = create();
  const results = await Promise.allSettled(
    ['accept', 'reject'].map((action) =>
      proposals.review(
        'p',
        proposal.id,
        { action: action as 'accept' | 'reject', version: 1 },
        'Reviewer',
      ),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([
    'fulfilled',
    'rejected',
  ]);
});

it('validates paths, revisions, sizes, duplicates and unambiguous replacements', () => {
  for (const overrides of [
    { file: '../secret' },
    { baseRevision: 'unknown' },
    { text: 'x'.repeat(9000) },
    { operation: 'replace', before: 'missing fragment' },
  ])
    expect(proposals.capture('p', source, block(overrides))).toBeNull();
  expect(
    proposals.capture('p', source, '```webui-memory-proposal\nnot json\n```'),
  ).toBeNull();
  expect(proposals.capture('different-project', source, block())).toBeNull();
  expect(
    proposals.capture(
      'p',
      source,
      block({
        operation: 'replace',
        before: '# Décisions du projet',
        text: '# Décisions validées',
      }),
    ),
  ).not.toBeNull();
});

it('retains proposals across service recreation and scopes access to their project', () => {
  const proposal = create();
  database.sqlite.close();
  database = createTestDatabase(path.join(root, 'database.sqlite'));
  const reloaded = new KnowledgeProposalsService(
    database.db,
    new ProjectKnowledgeService(database.db),
  );
  expect(reloaded.get('p', proposal.id).id).toBe(proposal.id);
  expect(() => reloaded.get('other', proposal.id)).toThrow('not found');
  database.db.delete(projects).run();
  expect(
    database.db.select().from(projectKnowledgeProposals).all(),
  ).toHaveLength(0);
});
