import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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

afterEach(() => vi.clearAllMocks());

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
    screen.getByRole('heading', { name: 'Connection interrupted' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Restore connection' }),
  ).toBeInTheDocument();
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
