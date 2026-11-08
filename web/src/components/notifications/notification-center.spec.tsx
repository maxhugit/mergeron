import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NotificationBell,
  NotificationCenter,
  NotificationPreferences,
} from './notification-center';
import { useInboxStore } from './inbox-state';
import { inboxFixture } from './inbox-fixture';
const router = vi.hoisted(() => ({ path: '/t/first', navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => router.navigate,
  useRouterState: () => router.path,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: { personId: 'me', kind: 'person', active: true },
  }),
}));
vi.mock('@/lib/session-recovery', () => ({ useSessionPaused: () => false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useInboxStore.setState({ open: false, filter: 'all', grouping: 'date' });
  vi.clearAllMocks();
});
it('marks read, filters, navigates to the agent and keeps the panel open across navigation', async () => {
  inboxFixture();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = () => (
    <QueryClientProvider client={client}>
      <NotificationBell />
      <NotificationCenter />
    </QueryClientProvider>
  );
  const rendered = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  expect(await screen.findByText('Notification 0')).toBeVisible();
  fireEvent.click(screen.getByText('Notification 0'));
  await waitFor(() =>
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/t/$threadId',
      params: { threadId: 'agent-0' },
    }),
  );
  router.path = '/t/agent-0';
  rendered.rerender(view());
  expect(screen.getByRole('region', { name: 'Notifications' })).toBeVisible();
  fireEvent.change(screen.getByLabelText('Filter by read status'), {
    target: { value: 'read' },
  });
  expect(await screen.findByText('Notification 0')).toBeVisible();
  await waitFor(() =>
    expect(screen.queryByText('Notification 1')).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Mark as unread' }));
  await waitFor(() =>
    expect(screen.getByText('No notifications in this filter.')).toBeVisible(),
  );
  client.clear();
});
it('groups distinct projects and saves a personal retention period', async () => {
  const fixture = inboxFixture();
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <NotificationCenter />
      <NotificationPreferences />
    </QueryClientProvider>,
  );
  act(() => useInboxStore.setState({ open: true, grouping: 'project' }));
  expect(
    await screen.findByRole('heading', { name: 'Mergeron' }),
  ).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Formation' })).toBeVisible();
  const days = await screen.findByLabelText('Keep notifications for');
  await waitFor(() => expect(days).toBeEnabled());
  fireEvent.change(days, { target: { value: '14' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(fixture.calls).toContainEqual({
      path: '/api/notifications/preferences',
      method: 'PATCH',
      body: { retentionDays: 14 },
    }),
  );
  client.clear();
});
