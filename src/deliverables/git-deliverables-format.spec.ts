import { expect, it } from 'vitest';
import {
  portableDeliverableId,
  portableDocumentId,
  readableDeliverableFolder,
  manifestSchema,
} from './git-deliverables-format';
it.each([
  ['Cadrage du site', 'cadrage-du-site'],
  ['Étude / devis : été !', 'etude-devis-ete'],
  ['../...', 'livrable'],
  ['Δοκιμή εγγράφου', 'δοκιμη-εγγραφου'],
])('creates a readable safe folder for %s', (title, expected) =>
  expect(readableDeliverableFolder(title)).toBe(expected),
);
it('keeps portable IDs stable, scoped and separate from local IDs', () => {
  const id = portableDeliverableId('project', 'board', 'local');
  expect(id).toMatch(/^deliverable-[a-f0-9]{32}$/);
  expect(id).toBe(portableDeliverableId('project', 'board', 'local'));
  expect(id).not.toBe(portableDeliverableId('other-project', 'board', 'local'));
  const doc = portableDocumentId(id, 'local-document');
  expect(doc).toMatch(/^document-[a-f0-9]{32}$/);
  expect(doc).not.toContain('local-document');
  expect(
    manifestSchema.parse({
      format: 'mergeron-deliverable',
      version: 1,
      id,
      title: 'Portable title',
      description: '',
      labels: [],
      documents: [{ id: doc, path: 'document.md', labels: [] }],
    }).id,
  ).toBe(id);
  expect(
    Buffer.byteLength(readableDeliverableFolder('Δοκιμή'.repeat(100))),
  ).toBeLessThan(255);
});

it('reserves byte space for a suffix with supplementary Unicode letters', () => {
  expect(
    Buffer.byteLength(readableDeliverableFolder('𐐀'.repeat(100)) + '-12345678'),
  ).toBeLessThan(255);
});
