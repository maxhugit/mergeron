import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useFocusedProjectThreads } from './use-focused-project-threads';
import { threadsListOverview } from '@/generated/api/sdk.gen';
import { threadsListOverviewQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import type { ProjectSummary } from '@/lib/projects-api';
vi.mock('@/generated/api/sdk.gen', () => ({ threadsListOverview: vi.fn() }));
const project = {
  id: 'p',
  workspacePath: '/a',
  workspaces: [{ path: '/a' }, { path: '/b' }],
  agentThreads: ['one', 'two', 'three'].map((threadId) => ({
    threadId,
    workspacePath: '/a',
  })),
} as ProjectSummary;
beforeEach(() => vi.mocked(threadsListOverview).mockReset());
const row = (id: string) => ({
  thread: {
    id,
    createdAt:
      ({ one: 3, two: 2, three: 4 } as Record<string, number>)[id] ?? 0,
  },
  memberThreadIds: [id],
});
function show(value: ProjectSummary | null = project) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = renderHook(() => useFocusedProjectThreads(value ?? undefined), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, client };
}
it('loads every page of every folder, filters other projects and deduplicates roots', async () => {
  vi.mocked(threadsListOverview)
    .mockResolvedValueOnce({
      data: { data: [row('one'), row('foreign')], nextCursor: 'page-two' },
    } as never)
    .mockResolvedValueOnce({
      data: { data: [row('two')], nextCursor: null },
    } as never)
    .mockResolvedValueOnce({
      data: { data: [row('two'), row('three')], nextCursor: null },
    } as never);
  const view = show();
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  expect(view.result.current.data!.data.map((item) => item.thread.id)).toEqual([
    'three',
    'one',
    'two',
  ]);
  expect(threadsListOverview).toHaveBeenCalledTimes(3);
  expect(
    vi
      .mocked(threadsListOverview)
      .mock.calls.map(([options]) => options?.query),
  ).toEqual([
    expect.objectContaining({ cwd: '/a', cursor: undefined }),
    expect.objectContaining({ cwd: '/a', cursor: 'page-two' }),
    expect.objectContaining({ cwd: '/b', cursor: undefined }),
  ]);
  expect(
    view.client
      .getQueryCache()
      .findAll({ queryKey: threadsListOverviewQueryKey() }),
  ).toHaveLength(1);
  view.unmount();
  view.client.clear();
});
it('fails visibly rather than looping or returning a partial list on a repeated cursor', async () => {
  vi.mocked(threadsListOverview).mockResolvedValue({
    data: { data: [], nextCursor: 'same' },
  } as never);
  const view = show();
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(threadsListOverview).toHaveBeenCalledTimes(2);
  expect(view.result.current.data).toBeUndefined();
  view.unmount();
  view.client.clear();
});
it('does not fetch when no project is focused', () => {
  const view = show(null);
  expect(threadsListOverview).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
});
