import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useMemo } from 'react';
import { createSidebarActivitySelector } from './sidebar-activity';
import { useTimelineStore } from '@/stores/timeline-store';

vi.mock('@/socket', () => ({
  getSocket: () => ({ emit: vi.fn(), connected: false }),
}));
const initial = useTimelineStore.getState();
beforeEach(() => {
  useTimelineStore.setState(initial, true);
});

it.each(['selected', 'background'])(
  'does not repaint navigation for 100 %s transcript updates',
  (target) => {
    const store = useTimelineStore.getState();
    store.ensureThreadState({ threadId: 'selected' });
    store.ensureThreadState({ threadId: 'background' });
    store.selectThread('selected');
    let renders = 0;
    let previousSubscriptionRenders = 0;
    const oldSubscription = renderHook(() => {
      useTimelineStore((state) => state.threadsById);
      previousSubscriptionRenders++;
    });
    const oldBaseline = previousSubscriptionRenders;
    const { result, unmount } = renderHook(() => {
      const selector = useMemo(() => createSidebarActivitySelector(), []);
      const value = useTimelineStore(selector);
      renders++;
      return value;
    });
    const initialRenders = renders;
    const before = result.current;
    for (let index = 0; index < 100; index++)
      act(() => {
        useTimelineStore
          .getState()
          .appendPlanDeltaForThread(target, 'turn', 'plan', 'text ');
      });
    expect(renders).toBe(initialRenders);
    expect(result.current).toBe(before);
    expect(previousSubscriptionRenders - oldBaseline).toBe(100);
    act(() =>
      useTimelineStore.getState().setTurnStartPendingForThread(target, true),
    );
    expect(renders).toBe(initialRenders + 1);
    expect(result.current.get(target)?.busy).toBe(true);
    act(() =>
      useTimelineStore.getState().setThreadStatusForThread(target, {
        type: 'active',
        activeFlags: ['waitingOnUserInput'],
      }),
    );
    expect(result.current.get(target)?.waitingOnUserInput).toBe(true);
    act(() => useTimelineStore.getState().forgetThreads([target]));
    expect(result.current.has(target)).toBe(false);
    unmount();
    oldSubscription.unmount();
  },
);

it('preserves request counts, selected-field authority and flags across lifecycle updates', () => {
  const store = useTimelineStore.getState();
  store.ensureThreadState({ threadId: 'selected' });
  store.selectThread('selected');
  const select = createSidebarActivitySelector();
  useTimelineStore.setState({
    activeTurnId: 'turn',
    threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
    approvals: { request: { status: 'pending' } as never },
  });
  expect(select(useTimelineStore.getState()).get('selected')).toEqual({
    busy: true,
    active: true,
    waitingOnApproval: true,
    waitingOnUserInput: false,
    pendingApprovalCount: 1,
  });
  useTimelineStore.setState({
    approvals: { request: { status: 'resolved' } as never },
  });
  expect(
    select(useTimelineStore.getState()).get('selected')?.pendingApprovalCount,
  ).toBe(0);
});
