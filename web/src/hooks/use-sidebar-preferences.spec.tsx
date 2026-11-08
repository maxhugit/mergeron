import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSidebarPreferences } from './use-sidebar-preferences';
const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@/lib/platform-session', () => ({
  readAuthResource: api.read,
  updateAuthResource: api.write,
}));
beforeEach(() => {
  api.read.mockReset();
  api.write.mockReset();
});
it('keeps a late save in its original person and agent cache after switching profiles', async () => {
  let finish!: (value: unknown) => void;
  api.read
    .mockResolvedValueOnce({ personId: 'alice', values: {} })
    .mockResolvedValueOnce({ personId: 'bob', values: {} });
  api.write.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ person, scope }) => useSidebarPreferences(person, scope),
    { wrapper, initialProps: { person: 'alice', scope: 'agent-a' } },
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => hook.result.current.set('open:task:t', true));
  await waitFor(() => expect(api.write).toHaveBeenCalled());
  hook.rerender({ person: 'bob', scope: 'agent-b' });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () =>
    finish({ personId: 'alice', values: { 'open:task:t': true } }),
  );
  expect(hook.result.current.values).toEqual({});
  expect(
    client.getQueryData(['sidebar-preferences', 'alice', 'agent-a']),
  ).toEqual({ personId: 'alice', values: { 'open:task:t': true } });
  expect(api.write).toHaveBeenCalledWith('me/sidebar/agent-a', {
    personId: 'alice',
    key: 'open:task:t',
    value: true,
  });
});
it('reports failed saves without changing the displayed saved value', async () => {
  api.read.mockResolvedValue({
    personId: 'alice',
    values: { 'open:task:t': false },
  });
  api.write.mockRejectedValue(Error('offline'));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSidebarPreferences('alice', 'agent-a'), {
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => hook.result.current.set('open:task:t', true));
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.values['open:task:t']).toBe(false);
});
