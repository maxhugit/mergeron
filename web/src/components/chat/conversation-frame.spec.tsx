import { useContext } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import { ConversationFrame } from './conversation-frame';
import { useTimelineStore } from '@/stores/timeline-store';
vi.mock('@/socket', () => ({
  getSocket: () => ({ connected: false, emit: vi.fn() }),
}));
vi.mock('./chat-input', () => ({
  ChatInput: ({ active }: { active: boolean }) => {
    const parent = useContext(SurfaceActivityContext);
    return (
      <div data-testid="composer-activity" data-active={active && parent} />
    );
  },
}));
vi.mock('./chat-timeline', () => ({
  ChatTimeline: ({ active, ready }: { active: boolean; ready: boolean }) => (
    <div
      data-testid="timeline-activity"
      data-active={active}
      data-ready={ready}
    />
  ),
}));
const initial = useTimelineStore.getState();
beforeEach(() => {
  useTimelineStore.setState(initial, true);
  useTimelineStore.getState().selectThread('a');
});
it('keeps the normal cold-open gate but permits an inert prefetched history preview', () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({
    threadId: 'a',
    turnsNewestFirst: [],
    historyCursor: null,
    readOnlyReason: null,
  });
  store.setOpenStateForThread('a', { openState: 'opening' });
  render(<ConversationFrame threadId="a" active onRetry={vi.fn()} />);
  expect(screen.getByTestId('timeline-activity')).toHaveAttribute(
    'data-ready',
    'false',
  );
  act(() => store.setOpenStateForThread('a', { historyPreview: true }));
  expect(screen.getByTestId('timeline-activity')).toHaveAttribute(
    'data-ready',
    'true',
  );
  expect(
    screen.getByTestId('timeline-activity').closest('[inert]'),
  ).not.toBeNull();
  act(() => store.setOpenStateForThread('a', { openState: 'ready' }));
  expect(store.getThreadRuntime('a')?.historyPreview).toBe(false);
  expect(screen.getByTestId('timeline-activity').closest('[inert]')).toBeNull();
});
it('cannot reactivate a composer or transcript inside a withdrawn agent/session surface', () => {
  const tree = (active: boolean) => (
    <SurfaceActivityContext value={active}>
      <ConversationFrame threadId="a" active onRetry={vi.fn()} />
    </SurfaceActivityContext>
  );
  const view = render(tree(true));
  expect(screen.getByTestId('composer-activity')).toHaveAttribute(
    'data-active',
    'true',
  );
  view.rerender(tree(false));
  expect(screen.getByTestId('composer-activity')).toHaveAttribute(
    'data-active',
    'false',
  );
  expect(screen.getByTestId('timeline-activity')).toHaveAttribute(
    'data-active',
    'false',
  );
});
