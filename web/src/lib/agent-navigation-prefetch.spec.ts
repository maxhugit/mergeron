import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  agentSnapshotKey,
  prefetchAgentNavigation,
} from './agent-navigation-prefetch';
import { threadsListTurns, threadsReadThread } from '@/generated/api/sdk.gen';
vi.mock('@/generated/api/sdk.gen', () => ({
  threadsReadThread: vi.fn(),
  threadsListTurns: vi.fn(),
}));
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(threadsReadThread)
    .mockReset()
    .mockImplementation(
      async ({ path }) =>
        ({ data: { thread: { id: path.threadId } } }) as never,
    );
  vi.mocked(threadsListTurns)
    .mockReset()
    .mockResolvedValue({ data: { data: [], nextCursor: null } } as never);
});
afterEach(() => client.clear());
it('reads only four background agents sequentially, caches one full recent page and reuses fresh reads', async () => {
  const signal = new AbortController().signal;
  await prefetchAgentNavigation(
    client,
    'owner',
    'project',
    ['b', 'c', 'd', 'e', 'f'],
    signal,
    () => true,
  );
  expect(threadsReadThread).toHaveBeenCalledTimes(4);
  expect(threadsListTurns).toHaveBeenCalledTimes(4);
  expect(
    vi
      .mocked(threadsReadThread)
      .mock.calls.map(([request]) => request.path.threadId),
  ).toEqual(['b', 'c', 'd', 'e']);
  expect(threadsListTurns).toHaveBeenCalledWith(
    expect.objectContaining({
      query: { limit: 20, sortDirection: 'desc', itemsView: 'full' },
      signal,
    }),
  );
  await prefetchAgentNavigation(
    client,
    'owner',
    'project',
    ['b'],
    signal,
    () => true,
  );
  expect(threadsReadThread).toHaveBeenCalledTimes(4);
  expect(
    client.getQueryData(agentSnapshotKey('other-owner', 'project', 'b')),
  ).toBeUndefined();
});
it('never caches a late read after cancellation and does not proceed to the next agent', async () => {
  const controller = new AbortController();
  vi.mocked(threadsReadThread).mockImplementationOnce(async () => {
    controller.abort();
    return { data: { thread: { id: 'b' } } } as never;
  });
  await prefetchAgentNavigation(
    client,
    'owner',
    'project',
    ['b', 'c'],
    controller.signal,
    () => true,
  );
  expect(threadsReadThread).toHaveBeenCalledTimes(1);
  expect(threadsListTurns).not.toHaveBeenCalled();
  expect(
    client.getQueryData(agentSnapshotKey('owner', 'project', 'b')),
  ).toBeUndefined();
});
it('checks current authorization before every read and continues after an individual failure', async () => {
  await prefetchAgentNavigation(
    client,
    'owner',
    'project',
    ['b'],
    new AbortController().signal,
    () => false,
  );
  expect(threadsReadThread).not.toHaveBeenCalled();
  vi.mocked(threadsReadThread).mockRejectedValueOnce(new Error('deleted'));
  await prefetchAgentNavigation(
    client,
    'owner',
    'project',
    ['b', 'c'],
    new AbortController().signal,
    () => true,
  );
  expect(
    client.getQueryData(agentSnapshotKey('owner', 'project', 'c')),
  ).toBeDefined();
  expect(
    client.getQueryData(agentSnapshotKey('owner', 'project', 'b')),
  ).toBeUndefined();
});
it('rejects metadata for a different conversation and downgraded history', async () => {
  vi.mocked(threadsReadThread).mockResolvedValueOnce({
    data: { thread: { id: 'other' } },
  } as never);
  vi.mocked(threadsListTurns).mockResolvedValueOnce({
    data: { data: [{ itemsView: 'metadata', items: [] }] },
  } as never);
  await prefetchAgentNavigation(
    client,
    'owner',
    'project',
    ['b', 'c'],
    new AbortController().signal,
    () => true,
  );
  expect(
    client.getQueryData(agentSnapshotKey('owner', 'project', 'b')),
  ).toBeUndefined();
  expect(
    client.getQueryData(agentSnapshotKey('owner', 'project', 'c')),
  ).toBeUndefined();
});
