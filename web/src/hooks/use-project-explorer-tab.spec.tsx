import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useProjectExplorerTab } from './use-project-explorer-tab';

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@/lib/platform-session', () => ({
  readAuthResource: api.read,
  updateAuthResource: api.write,
}));
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  api.read.mockReset();
  api.write.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => client.clear());

it('shares the project cache across agent lifetimes and reloads it from the server', async () => {
  api.read.mockResolvedValue({
    personId: 'alice',
    projectId: 'p',
    tab: 'deliverables',
  });
  const first = renderHook(() => useProjectExplorerTab('alice', 'p'), {
    wrapper,
  });
  await waitFor(() => expect(first.result.current.tab).toBe('deliverables'));
  first.unmount();
  const next = renderHook(() => useProjectExplorerTab('alice', 'p'), {
    wrapper,
  });
  expect(next.result.current.tab).toBe('deliverables');
  expect(api.read).toHaveBeenCalledTimes(1);
  next.unmount();
  client.clear();
  const reload = renderHook(() => useProjectExplorerTab('alice', 'p'), {
    wrapper,
  });
  await waitFor(() => expect(reload.result.current.tab).toBe('deliverables'));
  expect(api.read).toHaveBeenCalledTimes(2);
});

it('keeps late saves in their original person/project cache', async () => {
  let finish!: (value: unknown) => void;
  api.read
    .mockResolvedValueOnce({
      personId: 'alice',
      projectId: 'p',
      tab: 'folders',
    })
    .mockResolvedValueOnce({ personId: 'bob', projectId: 'q', tab: 'sources' });
  api.write.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = renderHook(
    ({ person, project }) => useProjectExplorerTab(person, project),
    {
      wrapper,
      initialProps: { person: 'alice', project: 'p' },
    },
  );
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  let saved!: Promise<boolean>;
  act(() => {
    saved = hook.result.current.select('deliverables');
  });
  await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
  hook.rerender({ person: 'bob', project: 'q' });
  await waitFor(() => expect(hook.result.current.tab).toBe('sources'));
  await act(async () => {
    finish({ personId: 'alice', projectId: 'p', tab: 'deliverables' });
    await saved;
  });
  expect(hook.result.current.tab).toBe('sources');
  expect(client.getQueryData(['project-explorer-tab', 'alice', 'p'])).toEqual({
    personId: 'alice',
    projectId: 'p',
    tab: 'deliverables',
  });
  expect(api.write).toHaveBeenCalledWith('me/project-explorer/p', {
    personId: 'alice',
    tab: 'deliverables',
  });
});

it('reports failed saves and never claims they persisted', async () => {
  api.read.mockResolvedValue({
    personId: 'alice',
    projectId: 'p',
    tab: 'folders',
  });
  api.write.mockRejectedValue(Error('offline'));
  const hook = renderHook(() => useProjectExplorerTab('alice', 'p'), {
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    expect(await hook.result.current.select('tasks')).toBe(false);
  });
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.tab).toBe('folders');
});

it('serializes choices from two retained agent panels instead of letting a late response win', async () => {
  api.read.mockResolvedValue({
    personId: 'alice',
    projectId: 'p',
    tab: 'folders',
  });
  let finish!: (value: unknown) => void;
  api.write
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({
      personId: 'alice',
      projectId: 'p',
      tab: 'sources',
    });
  const a = renderHook(() => useProjectExplorerTab('alice', 'p'), { wrapper });
  const b = renderHook(() => useProjectExplorerTab('alice', 'p'), { wrapper });
  await waitFor(() => expect(a.result.current.loading).toBe(false));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => {
    first = a.result.current.select('deliverables');
  });
  await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
  act(() => {
    second = b.result.current.select('sources');
  });
  await waitFor(() => expect(b.result.current.saving).toBe(true));
  expect(api.write).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ personId: 'alice', projectId: 'p', tab: 'deliverables' });
    await first;
    await second;
  });
  await waitFor(() => expect(a.result.current.tab).toBe('sources'));
  expect(b.result.current.tab).toBe('sources');
  expect(api.write).toHaveBeenCalledTimes(2);
});

it('rejects a read belonging to a different project instead of displaying it', async () => {
  api.read.mockResolvedValue({
    personId: 'alice',
    projectId: 'q',
    tab: 'sources',
  });
  const hook = renderHook(() => useProjectExplorerTab('alice', 'p'), {
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.tab).toBe('folders');
});

it('makes no personal requests outside an authenticated project', async () => {
  const hook = renderHook(() => useProjectExplorerTab(undefined, 'p'), {
    wrapper,
  });
  expect(hook.result.current.loading).toBe(false);
  expect(await hook.result.current.select('sources')).toBe(false);
  expect(api.read).not.toHaveBeenCalled();
  expect(api.write).not.toHaveBeenCalled();
});
