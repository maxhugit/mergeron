import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentNavigationPrefetch } from './use-agent-navigation-prefetch';
import { useAgentViewCacheStore as cache } from '@/stores/agent-view-cache-store';
import { useTimelineStore as timeline } from '@/stores/timeline-store';
import { sessionOwner } from '@/lib/session-recovery';
import { prefetchAgentNavigation } from '@/lib/agent-navigation-prefetch';
import type { PlatformSession } from '@/lib/platform-session';

const mock = vi.hoisted(() => ({ paused: false, warm: vi.fn() }));
const person: PlatformSession = {
  kind: 'person',
  personId: 'person',
  name: 'Fixture',
  active: true,
  role: 'administrator',
};
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: person,
    paused: mock.paused,
    isPending: false,
    isError: false,
  }),
}));
vi.mock('@/lib/agent-navigation-prefetch', async (original) => ({
  ...(await original<typeof import('@/lib/agent-navigation-prefetch')>()),
  prefetchAgentNavigation: vi.fn(async () => undefined),
}));
vi.mock('@/routes/project-resource-route', () => ({
  ProjectResourceRoute: mock.warm,
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({ connected: false, emit: vi.fn() }),
}));
const pristine = timeline.getState();
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  mock.paused = false;
  vi.mocked(prefetchAgentNavigation).mockClear();
  client = new QueryClient();
  timeline.setState(pristine, true);
  timeline.getState().ensureThreadState({ threadId: 'selected' });
  cache.setState({
    owner: sessionOwner(person),
    projectId: 'p',
    threadIds: ['outside', 'b', 'c', 'selected'],
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  cache.getState().clear();
  vi.useRealTimers();
});
function show() {
  return renderHook(
    ({ project, eligible }) =>
      useAgentNavigationPrefetch(project, 'selected', eligible),
    {
      initialProps: {
        project: 'p' as string | null,
        eligible: new Set(['selected', 'b', 'c']),
      },
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}
it('waits for selected agent readiness, then preloads recent eligible agents without mounting project pages', async () => {
  show();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(prefetchAgentNavigation).not.toHaveBeenCalled();
  act(() =>
    timeline
      .getState()
      .setOpenStateForThread('selected', { openState: 'ready' }),
  );
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(prefetchAgentNavigation).toHaveBeenCalledExactlyOnceWith(
    client,
    sessionOwner(person),
    'p',
    ['c', 'b'],
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(mock.warm).not.toHaveBeenCalled();
  expect(timeline.getState().threadId).toBeNull();
  expect(timeline.getState().subscribedThreadIds.size).toBe(0);
});
it('aborts stale work when disabled or eligibility changes and removes prefetched data on project change', async () => {
  timeline.getState().setOpenStateForThread('selected', { openState: 'ready' });
  const view = show();
  await act(() => vi.advanceTimersByTimeAsync(300));
  const signal = vi.mocked(prefetchAgentNavigation).mock.calls[0][4];
  client.setQueryData(
    ['agent-navigation-snapshot', sessionOwner(person), 'p', 'b'],
    { page: 'private' },
  );
  view.rerender({ project: null, eligible: new Set() });
  expect(signal.aborted).toBe(true);
  expect(
    client.getQueryData([
      'agent-navigation-snapshot',
      sessionOwner(person),
      'p',
      'b',
    ]),
  ).toBeUndefined();
});
it('does not read while the session is paused or the tab is hidden; resumes warm-up when visible', async () => {
  timeline.getState().setOpenStateForThread('selected', { openState: 'ready' });
  mock.paused = true;
  const view = show();
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(prefetchAgentNavigation).not.toHaveBeenCalled();
  mock.paused = false;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'hidden',
  });
  view.rerender({ project: 'p', eligible: new Set(['b']) });
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(prefetchAgentNavigation).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(prefetchAgentNavigation).toHaveBeenCalledTimes(1);
});
