import { expect, it } from 'vitest';
import { mergeCheckState } from './git-check-status';

it.each([
  [['success', 'neutral', 'skipped'], false, 'passed'],
  [['success', 'failure'], false, 'failed'],
  [['cancelled'], false, 'failed'],
  [['timed_out'], false, 'failed'],
  [['success', 'in_progress'], false, 'running'],
  [['queued'], false, 'running'],
  [[], false, 'none'],
  [[], true, 'unknown'],
  [['success'], true, 'unknown'],
  [['new_status'], false, 'unknown'],
  [['skipped', 'neutral'], false, 'unknown'],
] as const)(
  'aggregates %j (limited=%s) as %s',
  (statuses, limited, expected) => {
    expect(
      mergeCheckState({
        limited,
        items: statuses.map((status, i) => ({
          id: String(i),
          name: 'job',
          status,
        })),
      }),
    ).toBe(expected);
  },
);
