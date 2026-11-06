import { expect, it } from 'vitest';
import { gitPrStatus } from './git-pr-status';
import type { GitChecks } from './workspace-git-api';
const checks: GitChecks = {
  head: 'a',
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  limited: false,
  inspectedAt: 1,
  items: [{ id: '1', name: 'Test', status: 'success' }],
};
it('requires matching revision, complete observations and GitHub mergeability before ready', () => {
  expect(gitPrStatus('a', false, checks)).toBe('ready');
  expect(gitPrStatus('a', false, { ...checks, items: [] })).toBe('unknown');
  expect(gitPrStatus('new', false, checks)).toBe('unknown');
  expect(gitPrStatus('a', false, checks, true)).toBe('unknown');
  expect(gitPrStatus('a', false, { ...checks, limited: true })).toBe('unknown');
  expect(
    gitPrStatus('a', false, { ...checks, mergeableState: 'blocked' }),
  ).toBe('blocked');
  expect(gitPrStatus('a', false, { ...checks, mergeable: null })).toBe(
    'unknown',
  );
});
it('distinguishes errors, checks in progress, drafts and conflicts', () => {
  expect(gitPrStatus('a', true, checks)).toBe('draft');
  expect(gitPrStatus('a', false, { ...checks, mergeable: false })).toBe(
    'conflict',
  );
  for (const status of [
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
  ])
    expect(
      gitPrStatus('a', false, {
        ...checks,
        items: [{ id: '1', name: 'T', status }],
      }),
    ).toBe('error');
  expect(
    gitPrStatus('a', false, {
      ...checks,
      items: [{ id: '1', name: 'T', status: 'queued' }],
    }),
  ).toBe('checking');
  expect(
    gitPrStatus('a', false, {
      ...checks,
      items: [{ id: '1', name: 'T', status: 'future-state' }],
    }),
  ).toBe('unknown');
});
