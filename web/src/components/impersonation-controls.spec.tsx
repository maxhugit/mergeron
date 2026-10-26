import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  TestAsPersonButton,
  ImpersonationBanner,
  ImpersonationAuditButton,
} from './impersonation-controls';
const state = vi.hoisted(() => ({
  context: undefined as Record<string, unknown> | undefined,
  request: vi.fn(),
  reload: vi.fn(),
}));
vi.mock('@/lib/auth-api', () => ({ authRequest: state.request }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ data: { impersonation: state.context } }),
}));
vi.mock('@/lib/identity-switch', () => ({ reloadIdentity: state.reload }));
beforeEach(() => {
  state.context = undefined;
  state.request.mockReset().mockResolvedValue({});
  state.reload.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('requires explicit confirmation warning about real modifications before switching', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<TestAsPersonButton personId="target" name="Alice" />);
  fireEvent.click(screen.getByRole('button', { name: 'Test as this person' }));
  expect(confirm).toHaveBeenCalledWith(
    expect.stringContaining('Changes are real'),
  );
  expect(state.request).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Test as this person' }));
  await waitFor(() => expect(state.reload).toHaveBeenCalledOnce());
  expect(state.request).toHaveBeenCalledWith('impersonation', {
    method: 'POST',
    body: JSON.stringify({ personId: 'target' }),
  });
});
it('keeps the return control visible even for an expired or invalid test', async () => {
  state.context = {
    personName: 'Alice',
    administratorName: 'Admin',
    expiresAt: 0,
    expired: true,
  };
  render(<ImpersonationBanner />);
  expect(screen.getByRole('status')).toHaveTextContent('no longer valid');
  fireEvent.click(screen.getByRole('button', { name: 'Return to my account' }));
  await waitFor(() => expect(state.reload).toHaveBeenCalledOnce());
  expect(state.request).toHaveBeenCalledWith('impersonation', {
    method: 'DELETE',
  });
});
it('does not show an impersonation banner in a normal session', () => {
  render(<ImpersonationBanner />);
  expect(screen.queryByRole('status')).toBeNull();
});
it('shows both identities and keeps retry available when leaving fails', async () => {
  state.context = {
    personName: 'Alice',
    administratorName: 'Maxime',
    expiresAt: Date.now() + 900000,
  };
  state.request.mockRejectedValue(new Error('offline'));
  render(<ImpersonationBanner />);
  expect(screen.getByRole('status')).toHaveTextContent('Alice');
  expect(screen.getByRole('status')).toHaveTextContent('Maxime');
  fireEvent.click(screen.getByRole('button', { name: 'Return to my account' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Return to my account' }),
  ).toBeEnabled();
  expect(state.reload).not.toHaveBeenCalled();
});
it('loads the security audit only on demand and displays both actors', async () => {
  state.request.mockResolvedValue({
    events: [
      {
        id: 'audit',
        administratorName: 'Maxime',
        personName: 'Alice',
        action: 'started',
        createdAt: Date.now(),
      },
    ],
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ImpersonationAuditButton />
    </QueryClientProvider>,
  );
  expect(state.request).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Permission test audit' }),
  );
  expect(await screen.findByText('Maxime')).toBeVisible();
  expect(screen.getByText('Alice')).toBeVisible();
  expect(screen.getByText('Test started')).toBeVisible();
});
