import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import type { ProjectWorkspaceCopySummary } from '@/lib/projects-api';
import { emitFileChange } from '@/lib/file-change-events';
import { useGitCopyLiveUpdates } from './use-git-copy-live-updates';

const wire = vi.hoisted(() => ({
  handlers: new Map<string, Set<(payload: unknown) => void>>(),
  release: vi.fn(),
  acquire: vi.fn(),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    on: (name: string, handler: (payload: unknown) => void) => {
      const set = wire.handlers.get(name) ?? new Set();
      set.add(handler);
      wire.handlers.set(name, set);
    },
    off: (name: string, handler: (payload: unknown) => void) =>
      wire.handlers.get(name)?.delete(handler),
  }),
}));
vi.mock('@/lib/file-watch-leases', () => ({ acquireFileWatch: wire.acquire }));
const copy = {
  id: 'own',
  localPath: '/project/copy',
} as ProjectWorkspaceCopySummary;
let client: QueryClient;
let invalidate: MockInstance<QueryClient['invalidateQueries']>;
beforeEach(() => {
  vi.useFakeTimers();
  wire.handlers.clear();
  wire.release.mockReset();
  wire.acquire.mockReset().mockReturnValue(wire.release);
  client = new QueryClient();
  invalidate = vi.spyOn(client, 'invalidateQueries');
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const send = (event: string, value: unknown) => {
  for (const handler of wire.handlers.get(event) ?? []) handler(value);
};
it('coalesces local and external changes and invalidates only this copy, independent of file-tab selection', async () => {
  const view = renderHook(() => useGitCopyLiveUpdates('p', copy, 'agent'), {
    wrapper,
  });
  expect(wire.acquire).toHaveBeenCalledExactlyOnceWith('/project/copy');
  act(() => {
    emitFileChange({
      source: 'local',
      kind: 'invalidate',
      paths: ['/project/copy/src/file.ts'],
    });
    send('fs.changed', {
      watchPath: '/project/copy',
      changedPaths: ['/project/copy/.git/index'],
    });
    send('codex.notification', {
      method: 'item/completed',
      params: { threadId: 'agent' },
    });
  });
  expect(invalidate).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(invalidate).toHaveBeenCalledTimes(5);
  expect(
    invalidate.mock.calls.every(([arg]) =>
      JSON.stringify(arg).includes('"p","own"'),
    ),
  ).toBe(true);
  view.unmount();
  expect(wire.release).toHaveBeenCalledOnce();
  expect([...wire.handlers.values()].every((set) => set.size === 0)).toBe(true);
});
it('ignores another copy/thread and cancels late refresh on agent change', async () => {
  const view = renderHook(
    ({ thread }) => useGitCopyLiveUpdates('p', copy, thread),
    { wrapper, initialProps: { thread: 'first' } },
  );
  act(() => {
    emitFileChange({
      source: 'external',
      kind: 'invalidate',
      paths: ['/project/copy-other/file.ts'],
    });
    send('codex.notification', {
      method: 'turn/completed',
      params: { threadId: 'other' },
    });
  });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(invalidate).not.toHaveBeenCalled();
  act(() =>
    send('codex.notification', {
      method: 'turn/completed',
      params: { threadId: 'first' },
    }),
  );
  view.rerender({ thread: 'second' });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(invalidate).not.toHaveBeenCalled();
  act(() => send('connect', undefined));
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(invalidate).toHaveBeenCalledTimes(5);
  view.unmount();
});
it('never watches or refreshes an absent copy', () => {
  const view = renderHook(
    () => useGitCopyLiveUpdates('p', undefined, 'new-agent'),
    { wrapper },
  );
  expect(wire.acquire).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  view.unmount();
});
