import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { saveManagerUpdateReceipt } from '@/components/settings/manager-update-recovery';
import { AuthenticatedLayout } from './authenticated-layout';
import {
  AuthRedirectError,
  AuthResourceError,
  usePlatformSession,
} from '@/lib/platform-session';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => '/',
  Outlet: () => <div>Protected workspace</div>,
  Link: () => null,
}));
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  usePlatformSession: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function sessionFailure(error: Error) {
  vi.mocked(usePlatformSession).mockReturnValue({
    isPending: false,
    isError: true,
    error,
    data: {
      active: true,
      email: 'cached@example.test',
      subject: 'cached-subject',
      role: 'administrator',
    },
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePlatformSession>);
}

it('hides cached identity and protected content on transport failure', () => {
  sessionFailure(new TypeError('Load failed'));
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Reconnecting to the server…' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Restore connection' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/This page retries automatically/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Use another sign-in method' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('cached@example.test')).not.toBeInTheDocument();
  expect(screen.queryByText(/cached-subject/)).not.toBeInTheDocument();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
});

it('offers browser renewal for a proxy redirect rather than claiming the account is inactive', () => {
  sessionFailure(new AuthRedirectError());
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Session renewal required' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Restore connection' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
});

it('does not offer a transport recovery shortcut for a real access denial', () => {
  sessionFailure(new AuthResourceError('Forbidden', 403));
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Access unavailable' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Restore connection' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
});

function updateReceipt() {
  saveManagerUpdateReceipt({
    startedAt: Date.now(),
    operationId: 'operation',
    excludedOperationId: null,
    snapshot: {
      id: 'operation',
      status: 'running',
      phase: 'backingUp',
      backupRetained: false,
      images: {},
      previousImages: {},
      events: [
        { at: new Date().toISOString(), phase: 'backingUp', status: 'running' },
      ],
    },
  });
}
it('shows only the retained update monitor during restart, without authorizing cached identity or making protected requests', async () => {
  updateReceipt();
  sessionFailure(new AuthResourceError('Restarting', 503));
  const fetch = vi.spyOn(globalThis, 'fetch');
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole('dialog', { name: 'Update progress' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('log')).toHaveTextContent('Saving application data');
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
  expect(screen.queryByText('cached@example.test')).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  view.unmount();
  client.clear();
});
it('does not restore the update monitor in place of a real access denial', () => {
  updateReceipt();
  sessionFailure(new AuthResourceError('Forbidden', 403));
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Access unavailable' }),
  ).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
});
