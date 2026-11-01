import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOpenThread } from './use-thread-open';
import { useAgentViewCacheStore as cache } from '@/stores/agent-view-cache-store';
import { useTimelineStore as timeline } from '@/stores/timeline-store';
import { agentSnapshotKey } from '@/lib/agent-navigation-prefetch';
const mock = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock('@/socket', () => ({
  getSocket: () => ({ connected: false, emit: vi.fn() }),
}));
vi.mock('@/generated/api/@tanstack/react-query.gen', async (original) => ({
  ...(await original<
    typeof import('@/generated/api/@tanstack/react-query.gen')
  >()),
  threadsResumeThreadMutation: () => ({ mutationFn: mock.resume }),
}));
const pristine = timeline.getState();
let client: QueryClient;
beforeEach(() => {
  timeline.setState(pristine, true);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  cache.setState({
    owner: 'person',
    projectId: 'project',
    threadIds: ['agent'],
  });
  mock.resume.mockReset().mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  client.clear();
  cache.getState().clear();
});
function seed(updatedAt = Date.now()) {
  client.setQueryData(
    agentSnapshotKey('person', 'project', 'agent'),
    {
      metadata: {
        thread: { id: 'agent', name: 'Prefetched agent', cwd: '/workspace' },
      },
      page: { data: [], nextCursor: 'older' },
    },
    { updatedAt },
  );
}
function show() {
  return renderHook(useOpenThread, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
it('does not open a prefetched agent until selected, then seeds its history without claiming ready state', async () => {
  seed();
  const view = show();
  expect(mock.resume).not.toHaveBeenCalled();
  expect(timeline.getState().getThreadRuntime('agent')).toBeNull();
  act(() => view.result.current.mutate({ path: { threadId: 'agent' } }));
  await waitFor(() => expect(mock.resume).toHaveBeenCalledTimes(1));
  expect(timeline.getState().getThreadRuntime('agent')).toMatchObject({
    hydrated: true,
    threadTitle: 'Prefetched agent',
    openState: 'opening',
    historyCursor: 'older',
    activeTurnId: null,
  });
});
it.each(['expired', 'another account'])(
  'ignores %s snapshots',
  async (reason) => {
    seed(reason === 'expired' ? Date.now() - 61_000 : Date.now());
    if (reason === 'another account')
      cache.setState({ owner: 'another-person' });
    const view = show();
    act(() => view.result.current.mutate({ path: { threadId: 'agent' } }));
    await waitFor(() => expect(mock.resume).toHaveBeenCalledTimes(1));
    expect(timeline.getState().getThreadRuntime('agent')).toMatchObject({
      hydrated: false,
      openState: 'opening',
    });
  },
);
