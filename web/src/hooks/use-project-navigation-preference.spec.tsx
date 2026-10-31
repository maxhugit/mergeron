import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useProjectNavigationPreference } from './use-project-navigation-preference';
import {
  platformSessionKey,
  updateAuthResource,
  usePlatformSession,
  type PlatformSession,
} from '@/lib/platform-session';
import { useAgentViewCacheStore as cache } from '@/stores/agent-view-cache-store';
import { useSnackbarStore } from '@/stores/snackbar-store';
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  updateAuthResource: vi.fn(),
  usePlatformSession: vi.fn(),
}));
let client: QueryClient;
let person: PlatformSession;
beforeEach(() => {
  cache.getState().clear();
  useSnackbarStore.getState().clear();
  person = {
    kind: 'person',
    personId: 'a',
    name: 'A',
    active: true,
    role: 'administrator',
    fastNavigationProjectId: 'p',
  };
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(platformSessionKey, person);
  vi.mocked(usePlatformSession).mockImplementation(
    () =>
      ({
        data: person,
        paused: false,
        isPending: false,
        isError: false,
      }) as ReturnType<typeof usePlatformSession>,
  );
  vi.mocked(updateAuthResource).mockReset();
});
afterEach(() => client.clear());
function show() {
  return renderHook(useProjectNavigationPreference, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
it('restores the personal choice on a new page but never cached conversations', () => {
  const first = show();
  expect(cache.getState().projectId).toBe('p');
  cache.getState().visit('p', 'agent');
  first.unmount();
  cache.getState().clear();
  const second = show();
  expect(cache.getState()).toMatchObject({ projectId: 'p', threadIds: [] });
  second.unmount();
});
it('replaces the project and retained views when the connected person changes', () => {
  const view = show();
  cache.getState().visit('p', 'agent');
  person = { ...person, personId: 'b', fastNavigationProjectId: 'other' };
  view.rerender();
  expect(cache.getState()).toMatchObject({ projectId: 'other', threadIds: [] });
});
function pendingSave() {
  let resolve!: (value: { fastNavigationProjectId: string | null }) => void;
  vi.mocked(updateAuthResource).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r as typeof resolve;
      }),
  );
  return (projectId: string | null) =>
    resolve({ fastNavigationProjectId: projectId });
}
it('saves once and applies only the acknowledged choice', async () => {
  const resolve = pendingSave();
  const view = show();
  act(() => {
    view.result.current.toggle('other');
    view.result.current.toggle('third');
  });
  await waitFor(() => expect(updateAuthResource).toHaveBeenCalledTimes(1));
  expect(updateAuthResource).toHaveBeenCalledWith('preferences', {
    fastNavigationProjectId: 'other',
  });
  expect(cache.getState().projectId).toBe('p');
  await act(async () => resolve('other'));
  expect(cache.getState().projectId).toBe('other');
  expect(
    client.getQueryData<PlatformSession>(platformSessionKey)
      ?.fastNavigationProjectId,
  ).toBe('other');
});
it('persists disable as null and keeps unrelated profile fields', async () => {
  vi.mocked(updateAuthResource).mockResolvedValue({
    fastNavigationProjectId: null,
  });
  const view = show();
  act(() => view.result.current.toggle('p'));
  await waitFor(() => expect(cache.getState().projectId).toBeNull());
  expect(updateAuthResource).toHaveBeenCalledWith('preferences', {
    fastNavigationProjectId: null,
  });
  expect(
    client.getQueryData<PlatformSession>(platformSessionKey)?.personId,
  ).toBe('a');
});
it('retains the previous choice on failure without retrying', async () => {
  vi.mocked(updateAuthResource).mockRejectedValue(new Error('offline'));
  const view = show();
  act(() => view.result.current.toggle('other'));
  await waitFor(() =>
    expect(useSnackbarStore.getState().visible).toHaveLength(1),
  );
  expect(cache.getState().projectId).toBe('p');
  expect(updateAuthResource).toHaveBeenCalledTimes(1);
});
it('ignores a late response after the identity changes', async () => {
  const resolve = pendingSave();
  const view = show();
  act(() => view.result.current.toggle('other'));
  await waitFor(() => expect(updateAuthResource).toHaveBeenCalledTimes(1));
  person = { ...person, personId: 'b', fastNavigationProjectId: 'b-project' };
  client.setQueryData(platformSessionKey, person);
  view.rerender();
  await act(async () => resolve('other'));
  expect(cache.getState().projectId).toBe('b-project');
});
