import { expect, it } from 'vitest';
import { deliverableGitState, documentGitState } from './deliverable-git-state';
import type { Status } from './git-deliverables-api';
function data(): Status {
  return {
    boards: [
      {
        id: 'board',
        name: 'Deliverables',
        restricted: [],
        settings: {
          enabled: true,
          directory: 'livrables',
          restrictedIds: [],
          lastError: null,
          lastSyncAt: 123,
        },
      },
    ],
    copies: [
      {
        id: 'copy',
        name: 'Copy',
        owned: true,
        writable: true,
        eligible: true,
        context: { branch: 'refs/heads/main', head: 'a' },
        lastSyncAt: 123,
      },
    ],
    discovered: [],
    discoveryError: null,
    proposal: {
      canApply: true,
      fingerprint: 'verified',
      context: { branch: 'refs/heads/main', head: 'a' },
      changes: [],
    },
  };
}
it('isolates version states by document and never inherits a sibling conflict or copy pending flag', () => {
  const value = data();
  value.copies[0].pending = true;
  value.copies[0].lastError = 'GIT_DELIVERABLES_REVIEW_REQUIRED';
  value.proposal!.changes = [
    {
      deliverable: 'Cadrage',
      deliverableId: 'a',
      action: 'conflict',
      reason: 'metadata_baseline_missing',
    },
    {
      deliverable: 'Cadrage',
      deliverableId: 'a',
      document: 'one.md',
      documentId: 'one',
      action: 'conflict',
      reason: 'document_changed_both',
    },
    {
      deliverable: 'Cadrage',
      deliverableId: 'a',
      document: 'two.md',
      documentId: 'two',
      action: 'export',
      reason: 'new_document',
    },
    {
      deliverable: 'Other',
      deliverableId: 'b',
      document: 'three.md',
      documentId: 'other',
      action: 'conflict',
      reason: 'document_changed_both',
    },
  ];
  expect(documentGitState(value, 'copy', 'a', 'one', 'one.md')).toBe('error');
  expect(documentGitState(value, 'copy', 'a', 'two', 'two.md')).toBe('pending');
  expect(documentGitState(value, 'copy', 'a', 'three', 'three.md')).toBe(
    'ready',
  );
  value.proposal!.changes.push({
    deliverable: 'Cadrage',
    deliverableId: 'a',
    document: 'four.md',
    documentId: 'four',
    action: 'import',
    reason: 'document',
  });
  expect(documentGitState(value, 'copy', 'a', 'four', 'four.md')).toBe(
    'review',
  );
  expect(
    documentGitState(value, 'copy', 'a', 'two', 'two.md', false, true),
  ).toBe('error');
  value.copies[0].context!.head = 'changed';
  expect(documentGitState(value, 'copy', 'a', 'three', 'three.md')).toBe(
    'pending',
  );
});
it('never treats a timestamp, stale context, active verification or failed refresh as current proof', () => {
  const value = data();
  expect(deliverableGitState(value, 'copy')).toBe('ready');
  expect(deliverableGitState(value, 'copy', undefined, true)).toBe('checking');
  expect(deliverableGitState(value, 'copy', undefined, false, true)).toBe(
    'error',
  );
  value.proposal = null;
  expect(deliverableGitState(value, 'copy')).toBe('checking');
  value.proposal = data().proposal;
  value.copies[0].context!.branch = 'refs/heads/other';
  expect(deliverableGitState(value, 'copy')).toBe('checking');
  value.copies[0].context = { branch: 'refs/heads/main', head: 'b' };
  expect(deliverableGitState(value, 'copy')).toBe('checking');
});
it('keeps per-deliverable states independent even for duplicate titles', () => {
  const value = data();
  value.proposal!.changes = [
    {
      deliverable: 'Same title',
      deliverableId: 'a',
      action: 'import',
      reason: 'document_changed_in_git',
    },
    {
      deliverable: 'Same title',
      deliverableId: 'b',
      action: 'export',
      reason: 'new_document',
    },
  ];
  expect(deliverableGitState(value, 'copy', 'a')).toBe('review');
  expect(deliverableGitState(value, 'copy', 'b')).toBe('pending');
  expect(deliverableGitState(value, 'copy', 'c')).toBe('ready');
  expect(deliverableGitState(value, 'copy')).toBe('review');
});
it('shows required review from a current comparison without disguising real failures', () => {
  const value = data();
  value.copies[0].lastError = 'GIT_DELIVERABLES_REVIEW_REQUIRED';
  value.copies[0].pending = true;
  value.proposal!.canApply = false;
  value.proposal!.changes = [
    {
      deliverable: 'Cadrage',
      deliverableId: 'a',
      action: 'conflict',
      reason: 'metadata_baseline_missing',
    },
    {
      deliverable: 'Maquette',
      deliverableId: 'b',
      action: 'export',
      reason: 'new_deliverable',
    },
  ];
  expect(deliverableGitState(value, 'copy')).toBe('review');
  expect(deliverableGitState(value, 'copy', 'a')).toBe('review');
  expect(deliverableGitState(value, 'copy', 'b')).toBe('pending');
  value.copies[0].pending = false;
  expect(deliverableGitState(value, 'copy', 'unaffected')).toBe('ready');
  value.copies[0].lastError = 'GIT_DELIVERABLES_SYNC_FAILED';
  expect(deliverableGitState(value, 'copy')).toBe('error');
  value.copies[0].lastError = 'GIT_DELIVERABLES_REVIEW_REQUIRED';
  value.discoveryError = 'GIT_UNAVAILABLE';
  expect(deliverableGitState(value, 'copy')).toBe('error');
  value.discoveryError = null;
  value.proposal = null;
  expect(deliverableGitState(value, 'copy')).toBe('checking');
  value.proposal = data().proposal;
  expect(deliverableGitState(value, 'copy')).toBe('ready');
  value.proposal!.context!.head = 'stale';
  expect(deliverableGitState(value, 'copy')).toBe('checking');
});
it.each([
  ['noCopy', 'missing'],
  ['readOnly', 'readonly'],
  ['off', 'disabled'],
  ['syncing', 'active'],
  ['pending', 'pending'],
  ['error', 'unavailable'],
  ['checking', 'changed'],
] as const)(
  'distinguishes %s without asserting synchronization',
  (expected, scenario) => {
    const value = data();
    let id: string | undefined = 'copy';
    if (scenario === 'missing') id = undefined;
    if (scenario === 'readonly') value.copies[0].writable = false;
    if (scenario === 'disabled') value.boards[0].settings!.enabled = false;
    if (scenario === 'active') value.active = true;
    if (scenario === 'pending') value.copies[0].pending = true;
    if (scenario === 'unavailable') value.discoveryError = 'GIT_UNAVAILABLE';
    if (scenario === 'changed')
      value.discoveryError = 'GIT_DELIVERABLES_CHANGED';
    expect(deliverableGitState(value, id)).toBe(expected);
  },
);
