import { expect, it } from 'vitest';
import { technicalFileActivity } from './technical-file-activity';
import { normalizeThreadItem, mergeTurnItem } from './thread-item-normalizer';
it('retains structured reads through live/history normalization and partial updates, without parsing shell text', () => {
  const normalized = normalizeThreadItem(
    {
      type: 'commandExecution',
      id: 'read',
      command: 'cat secret.txt',
      commandActions: [
        { type: 'read', path: 'src/app.ts' },
        { type: 'read', path: 'src/app.ts' },
        { type: 'search', path: 'src' },
        { type: 'read', path: 12 },
      ],
      exitCode: 0,
    },
    true,
    'read',
  );
  if (normalized.kind !== 'render') throw Error('Missing command');
  expect(technicalFileActivity([normalized.item])).toEqual([
    { path: 'src/app.ts', action: 'read', state: 'completed' },
  ]);
  const partial = normalizeThreadItem(
    { type: 'commandExecution', id: 'read', aggregatedOutput: 'done' },
    true,
    'read',
  );
  if (partial.kind !== 'render') throw Error('Missing update');
  expect(
    technicalFileActivity([mergeTurnItem(normalized.item, partial.item)]),
  ).toEqual([{ path: 'src/app.ts', action: 'read', state: 'completed' }]);
  expect(
    technicalFileActivity([
      {
        type: 'commandExecution',
        itemId: 'unknown',
        command: 'cat secret.txt',
        content: '',
        completed: true,
      },
    ]),
  ).toEqual([]);
});
it('lists every changed file, deduplicates paths and retains execution states', () => {
  expect(
    technicalFileActivity([
      {
        type: 'fileChange',
        itemId: 'changes',
        content: '',
        completed: true,
        fileChanges: [
          { path: 'new.md', diff: '', changeKind: 'add' },
          { path: 'app.ts', diff: '', changeKind: 'update' },
          { path: 'old.txt', diff: '', changeKind: 'delete' },
        ],
      },
      {
        type: 'fileChange',
        itemId: 'again',
        content: '',
        completed: false,
        fileChanges: [{ path: 'app.ts', diff: '', changeKind: 'update' }],
      },
      {
        type: 'commandExecution',
        itemId: 'read',
        completed: true,
        content: '',
        exitCode: 1,
        readPaths: ['missing.txt'],
      },
    ]),
  ).toEqual([
    { path: 'new.md', action: 'add', state: 'completed' },
    { path: 'app.ts', action: 'update', state: 'running' },
    { path: 'old.txt', action: 'delete', state: 'completed' },
    { path: 'missing.txt', action: 'read', state: 'failed' },
  ]);
});
