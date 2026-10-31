import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useThreadExecutionPreferences } from './use-thread-execution-preferences';
import { useModelStore } from '@/stores/model-store';
import {
  requestExecutionPreferences,
  type AgentExecutionPreferences,
} from '@/lib/thread-execution-preferences';
import { invalidateThreadEpoch } from '@/lib/thread-recovery-epoch';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  useModelStore.getState().clearOverrides();
  vi.unstubAllGlobals();
});
function mount(id = 'a') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return renderHook(({ id }) => useThreadExecutionPreferences(id), {
    initialProps: { id },
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
}
function memory() {
  const rows: Record<string, AgentExecutionPreferences> = {
    a: { revision: 1, effort: 'high' },
    b: { revision: 1, effort: 'low' },
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const id = /threads\/([^/]+)/.exec(url)![1];
    if (init?.method === 'PATCH')
      rows[id] = {
        ...rows[id],
        ...JSON.parse(init.body as string),
        revision: rows[id].revision + 1,
      };
    return { ok: true, json: async () => ({ ...rows[id] }) };
  });
  vi.stubGlobal('fetch', fetch);
  return { rows, fetch };
}
it('only reads on opening, restores after a client reload, and keeps agents independent', async () => {
  const api = memory();
  const view = mount();
  await waitFor(() =>
    expect(view.result.current.preferences?.effort).toBe('high'),
  );
  expect(api.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
    true,
  );
  act(() => view.result.current.save({ effort: 'medium', serviceTier: null }));
  await waitFor(() =>
    expect(view.result.current.preferences?.effort).toBe('medium'),
  );
  expect(api.rows.a.serviceTier).toBeNull();
  view.rerender({ id: 'b' });
  await waitFor(() =>
    expect(view.result.current.preferences?.effort).toBe('low'),
  );
  view.unmount();
  useModelStore.getState().clearOverrides();
  const reload = mount();
  await waitFor(() =>
    expect(reload.result.current.preferences?.effort).toBe('medium'),
  );
  expect(api.rows.b.effort).toBe('low');
});
it('does not claim a rejected mutation is saved or issue a second mutation on a rapid repeat click', async () => {
  memory();
  const view = mount();
  await waitFor(() => expect(view.result.current.busy).toBe(false));
  let reject!: (error: Error) => void;
  const fetch = vi.fn(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  act(() => {
    view.result.current.save({ effort: 'max' });
    view.result.current.save({ effort: 'low' });
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(view.result.current.busy).toBe(true);
  await act(async () => reject(new Error('Denied')));
  await waitFor(() => expect(view.result.current.busy).toBe(false));
  expect(view.result.current.preferences?.effort).toBe('high');
});
it('never replaces newer saved choices with a late read and clears deleted-agent caches', () => {
  const store = useModelStore.getState();
  store.recordPreferences('a', { revision: 3, effort: 'high' });
  store.recordPreferences('a', { revision: 2, effort: 'low' });
  expect(useModelStore.getState().preferencesByThread.a.effort).toBe('high');
  store.forgetObservedThreadEffort('a');
  expect(useModelStore.getState().preferencesByThread.a).toBeUndefined();
});
it('does not apply an asynchronous response from a discarded agent incarnation', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const request = requestExecutionPreferences('discarded');
  invalidateThreadEpoch('discarded');
  finish({ ok: true, json: async () => ({ revision: 2, effort: 'high' }) });
  await expect(request).rejects.toThrow('stale agent preferences');
});

it('holds sending when the initial settings read failed instead of inventing defaults', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false })),
  );
  const view = mount('unavailable');
  await waitFor(() => expect(view.result.current.error).toBe(true));
  expect(view.result.current.busy).toBe(true);
  expect(useModelStore.getState().loadingPreferencesByThread.unavailable).toBe(
    true,
  );
  expect(view.result.current.preferences).toBeUndefined();
});
