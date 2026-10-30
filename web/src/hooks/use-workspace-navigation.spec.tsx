import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useState, type PropsWithChildren } from 'react';
import type { ThreadDto } from '@/generated/api';
const calls = vi.hoisted(() => ({
  open: vi.fn(),
  check: vi.fn(),
  socket: { connected: true, emit: vi.fn() },
}));
vi.mock('./use-thread-open', () => ({
  useOpenThread: () => ({ mutate: calls.open }),
  applyReadOnlySnapshot: vi.fn(),
  HISTORY_PAGE_SIZE: 20,
}));
vi.mock('@/lib/navigation-workspace-check', () => ({
  checkNavigationWorkspaces: calls.check,
}));
vi.mock('@/socket', () => ({ getSocket: () => calls.socket }));
import { useWorkspaceNavigation } from './use-workspace-navigation';
import { useTimelineStore as timeline } from '@/stores/timeline-store';
import { useAgentViewCacheStore as cache } from '@/stores/agent-view-cache-store';
const pristine = timeline.getState();
beforeEach(() => {
  timeline.setState(pristine, true);
  cache.getState().clear();
  calls.socket.connected = true;
  calls.check.mockReset().mockResolvedValue(undefined);
  calls.open
    .mockReset()
    .mockImplementation(({ path }) =>
      timeline.getState().selectThread(path.threadId),
    );
});
function Wrapper({ children }: PropsWithChildren) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function ready() {
  timeline.getState().ensureThreadState({ threadId: 'a' });
  timeline.getState().hydrateOpenedThread({
    threadId: 'a',
    turnsNewestFirst: [],
    historyCursor: null,
    readOnlyReason: null,
  });
  timeline.getState().setOpenStateForThread('a', { openState: 'ready' });
  timeline.setState({
    subscribedThreadIds: new Set(['a']),
    confirmedThreadIds: new Set(['a']),
    retainedThreadIds: new Set(['a']),
  });
  cache.getState().toggleProject('p');
  cache.getState().visit('p', 'a');
}
it('selects a live retained view immediately, without resume/history/disk requests', () => {
  ready();
  renderHook(() => useWorkspaceNavigation('a'), { wrapper: Wrapper });
  expect(timeline.getState().threadId).toBe('a');
  expect(calls.check).not.toHaveBeenCalled();
  expect(calls.open).not.toHaveBeenCalled();
});
it.each([
  'not-confirmed',
  'disconnected',
  'system-error',
  'read-only',
  'mode-off',
  'deleted',
])('does a cold refresh when the cached view is %s', async (condition) => {
  ready();
  if (condition === 'not-confirmed')
    timeline.getState().clearConfirmedThreads();
  if (condition === 'disconnected') calls.socket.connected = false;
  if (condition === 'system-error')
    timeline.getState().setThreadStatusForThread('a', { type: 'systemError' });
  if (condition === 'read-only')
    timeline.getState().setReadOnlyThread({ id: 'a' } as ThreadDto);
  if (condition === 'mode-off') cache.getState().clear();
  if (condition === 'deleted') timeline.getState().forgetThreads(['a']);
  renderHook(() => useWorkspaceNavigation('a'), { wrapper: Wrapper });
  await waitFor(() => expect(calls.open).toHaveBeenCalledTimes(1));
  expect(calls.check).toHaveBeenCalledTimes(1);
});
it('explicit Retry bypasses the warm shortcut', async () => {
  ready();
  const view = renderHook(() => useWorkspaceNavigation('a'), {
    wrapper: Wrapper,
  });
  act(() => view.result.current(true));
  await waitFor(() => expect(calls.open).toHaveBeenCalledTimes(1));
  expect(calls.check).toHaveBeenCalledWith(expect.anything(), true);
});
it('a delayed disk reconciliation cannot reopen an agent after navigation', async () => {
  let finish!: () => void;
  calls.check.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const view = renderHook(({ id }) => useWorkspaceNavigation(id), {
    wrapper: Wrapper,
    initialProps: { id: 'a' },
  });
  view.rerender({ id: 'b' });
  await act(async () => finish());
  expect(calls.open).toHaveBeenCalledTimes(1);
  expect(calls.open.mock.calls[0][0]).toEqual({ path: { threadId: 'b' } });
  expect(timeline.getState().threadId).toBe('b');
});
