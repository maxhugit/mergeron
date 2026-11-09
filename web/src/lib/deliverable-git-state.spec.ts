import { expect, it } from 'vitest';
import { deliverableGitState } from './deliverable-git-state';
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
