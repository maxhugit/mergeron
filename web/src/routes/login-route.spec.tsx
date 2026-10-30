import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginRoute } from './login-route';
import { installSessionRecovery } from '@/lib/session-recovery';

const routing = vi.hoisted(() => ({
  search: { redirect: '/t/current', manual: true, renew: false },
  navigate: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => routing.navigate,
  useSearch: () => routing.search,
}));
vi.mock('@/lib/session-renewal', () => ({
  notifySessionRenewed: routing.notify,
  renewalReturnPath: '/login?renew=true',
}));
vi.mock('@/socket', () => ({ resetSocket: vi.fn() }));
vi.mock('@/components/login', () => ({
  LoginPage: ({
    onLocalLogin,
  }: {
    onLocalLogin: (name: string, password: string) => Promise<boolean>;
  }) => (
    <button onClick={() => void onLocalLogin('account', 'password')}>
      Sign in locally
    </button>
  ),
}));

let dispose: () => void;
let identityActive = true;
const network = vi.fn<typeof fetch>();
beforeEach(() => {
  routing.search = { redirect: '/t/current', manual: true, renew: false };
  identityActive = true;
  network.mockReset().mockImplementation(async (input) => {
    const path = String(input);
    const data = path.endsWith('/methods')
      ? { localEnabled: true }
      : path.endsWith('/me')
        ? {
            kind: 'person',
            personId: 'person',
            name: 'Person',
            role: 'administrator',
            active: identityActive,
          }
        : {};
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.spyOn(window, 'fetch').mockImplementation(network);
  dispose = installSessionRecovery();
});
afterEach(() => {
  dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('keeps normal local login working and verifies identity before navigating', async () => {
  render(<LoginRoute />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Sign in locally' }),
  );
  await waitFor(() =>
    expect(routing.navigate).toHaveBeenCalledWith({ to: '/t/current' }),
  );
  expect(routing.notify).not.toHaveBeenCalled();
});

it('finishes popup renewal without navigating the original work route', async () => {
  routing.search = {
    redirect: '/login?renew=true',
    renew: true,
    manual: false,
  };
  render(<LoginRoute />);
  await waitFor(() => expect(routing.notify).toHaveBeenCalledOnce());
  expect(screen.getByRole('status')).toHaveTextContent('Connection restored');
  expect(routing.navigate).not.toHaveBeenCalled();
});

it('allows manual sign-in even if a different account is already active in the popup', async () => {
  routing.search.renew = true;
  render(<LoginRoute />);
  const button = await screen.findByRole('button', { name: 'Sign in locally' });
  expect(routing.notify).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(routing.notify).toHaveBeenCalledOnce());
  expect(routing.navigate).not.toHaveBeenCalled();
});

it('never completes login for an inactive identity', async () => {
  identityActive = false;
  render(<LoginRoute />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Sign in locally' }),
  );
  await waitFor(() => expect(network).toHaveBeenCalledTimes(3));
  expect(routing.navigate).not.toHaveBeenCalled();
  expect(routing.notify).not.toHaveBeenCalled();
});
