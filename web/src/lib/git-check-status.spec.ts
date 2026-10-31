import { expect, it } from 'vitest';
import { mergeCheckState } from './git-check-status';

it.each([
  [['success', 'neutral', 'skipped'], false, 'passed'],
  [['success', 'failure'], false, 'failed'],
  [['cancelled'], false, 'failed'],
  [['timed_out'], false, 'failed'],
  [['success', 'in_progress'], false, 'running'],
  [['queued'], false, 'waiting'],
  [['pending'], false, 'waiting'],
  [['waiting'], false, 'waiting'],
  [['requested'], false, 'waiting'],
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

it.each([
  ['pending', true, false, 'waiting'],
  ['in_progress', true, false, 'running'],
  ['failure', true, false, 'failed'],
  ['success', true, false, 'passed'],
  ['success', true, true, 'unknown'],
  ['success', false, false, 'unknown'],
  ['unexpected', true, false, 'unknown'],
] as const)(
  'combines workflow %s with checks conservatively',
  (status, available, limited, expected) => {
    expect(
      mergeCheckState({
        items: [],
        limited: false,
        workflows: {
          available,
          limited,
          items: [
            {
              id: 1,
              name: 'Publish',
              status,
              url: 'https://github.com/example/demo/actions/runs/1',
            },
          ],
        },
      }),
    ).toBe(expected);
  },
);
