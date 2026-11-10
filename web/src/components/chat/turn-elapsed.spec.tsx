import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnElapsed } from './turn-elapsed';
import { elapsedMilliseconds } from '@/lib/turn-elapsed';
const entry = {
  kind: 'turn' as const,
  turnId: 't',
  items: [],
  completed: false,
  startedAt: 100,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('uses seconds for native timestamps, freezes on completion and prefers recorded duration', () => {
  expect(elapsedMilliseconds(entry, true, 165000)).toBe(65000);
  expect(
    elapsedMilliseconds({ ...entry, completedAt: 170 }, false, 999000),
  ).toBe(70000);
  expect(
    elapsedMilliseconds({ ...entry, durationMs: 4567 }, false, 999000),
  ).toBe(4567);
  expect(
    elapsedMilliseconds({ ...entry, startedAt: null }, true, 999000),
  ).toBeNull();
});
it('ticks only while running, then shows the terminal status and frozen time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(165000);
  const view = render(<TurnElapsed entry={entry} running />);
  expect(screen.getByText(/1 min 05 s/)).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByText(/1 min 07 s/)).toBeInTheDocument();
  view.rerender(
    <TurnElapsed
      entry={{
        ...entry,
        status: 'interrupted',
        completed: true,
        durationMs: 67000,
      }}
      running={false}
    />,
  );
  act(() => {
    vi.advanceTimersByTime(20000);
  });
  expect(screen.getByText(/1 min 07 s/)).toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
});

it('restores native timing from persisted conversation history', async () => {
  const { turnsToTimeline } = await import('@/stores/timeline-history-entries');
  const rows = turnsToTimeline([
    {
      id: 'persisted',
      items: [],
      itemsView: 'full',
      status: 'failed',
      error: null,
      startedAt: 100,
      completedAt: 170,
      durationMs: 69500,
    },
  ]);
  const turn = rows.find((row) => row.kind === 'turn');
  expect(turn).toMatchObject({
    startedAt: 100,
    completedAt: 170,
    durationMs: 69500,
    status: 'failed',
  });
  if (turn?.kind !== 'turn') throw Error('Missing turn');
  expect(elapsedMilliseconds(turn, false, 999000)).toBe(69500);
});
