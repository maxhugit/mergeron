import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { checkNavigationWorkspaces } from './navigation-workspace-check';
const request = vi.hoisted(() => vi.fn());
vi.mock('./projects-api', () => ({
  projectsApi: request,
  projectsQueryKey: ['projects'],
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));
beforeEach(() => {
  request.mockReset().mockResolvedValue({ removed: [], unresolved: [] });
});
afterEach(() => vi.useRealTimers());
it('coalesces concurrent checks and reuses successful checks for 30 seconds', async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  let finish!: (value: { removed: string[]; unresolved: string[] }) => void;
  request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = checkNavigationWorkspaces(client);
  expect(checkNavigationWorkspaces(client)).toBe(first);
  finish({ removed: [], unresolved: [] });
  await first;
  await checkNavigationWorkspaces(client);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue({ removed: [], unresolved: [] });
  vi.advanceTimersByTime(30_001);
  await checkNavigationWorkspaces(client);
  expect(request).toHaveBeenCalledTimes(2);
});
it('never reuses a failure, supports explicit retry and does not share clients', async () => {
  const client = new QueryClient();
  request.mockRejectedValueOnce(new Error('offline'));
  await checkNavigationWorkspaces(client);
  await checkNavigationWorkspaces(client);
  await checkNavigationWorkspaces(client, true);
  await checkNavigationWorkspaces(new QueryClient());
  expect(request).toHaveBeenCalledTimes(4);
});

it('invalidates an earlier success when an explicit retry fails', async () => {
  const client = new QueryClient();
  await checkNavigationWorkspaces(client);
  request.mockRejectedValueOnce(new Error('offline'));
  await checkNavigationWorkspaces(client, true);
  await checkNavigationWorkspaces(client);
  expect(request).toHaveBeenCalledTimes(3);
});
