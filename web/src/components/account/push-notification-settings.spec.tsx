import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PushNotificationSettings } from './push-notification-settings';
import * as push from '@/lib/push-notifications';
import type { PlatformSession } from '@/lib/platform-session';
const session = vi.hoisted(() => ({
  data: {
    kind: 'person',
    personId: 'p',
    active: true,
    role: 'standard',
  } as PlatformSession,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => session,
}));
vi.mock('@/lib/push-notifications', () => ({
  readPushStatus: vi.fn(),
  browserPushEnabled: vi.fn(),
  currentPushDevice: vi.fn(),
  pushSupported: vi.fn(),
  enablePush: vi.fn(),
  revokePushDevice: vi.fn(),
  testPushDevice: vi.fn(),
  unsubscribeBrowserPush: vi.fn(),
  updatePushDevice: vi.fn(),
}));
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  session.data = {
    kind: 'person',
    personId: 'p',
    active: true,
    role: 'standard',
    name: 'Person',
  };
  vi.mocked(push.readPushStatus).mockResolvedValue({
    configured: true,
    publicKey: 'key',
    devices: [],
  });
  vi.mocked(push.browserPushEnabled).mockResolvedValue(false);
  vi.mocked(push.pushSupported).mockReturnValue(true);
  vi.mocked(push.currentPushDevice).mockReturnValue(null);
  vi.stubGlobal('Notification', { permission: 'default' });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const show = () =>
  render(
    <QueryClientProvider client={client}>
      <PushNotificationSettings />
    </QueryClientProvider>,
  );
it('never asks for permission automatically and enables only after a named-device explicit click', async () => {
  show();
  const enable = await screen.findByRole('button', {
    name: 'Enable on this device',
  });
  expect(enable).toBeDisabled();
  expect(push.enablePush).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByRole('textbox', { name: 'This device’s name' }),
    { target: { value: 'My Mac' } },
  );
  await waitFor(() => expect(enable).toBeEnabled());
  fireEvent.click(enable);
  await waitFor(() =>
    expect(push.enablePush).toHaveBeenCalledWith('p', 'key', 'My Mac', 'en'),
  );
});
it('lists only server-returned personal devices and provides independent preferences, test and revoke', async () => {
  const device = {
    id: 'd',
    label: 'My phone',
    language: 'en',
    completed: true,
    approvals: false,
    questions: true,
    createdAt: 1,
    updatedAt: 1,
    lastTestStatus: 'sent' as const,
  };
  vi.mocked(push.readPushStatus).mockResolvedValue({
    configured: true,
    publicKey: 'key',
    devices: [device],
  });
  vi.mocked(push.currentPushDevice).mockReturnValue({ id: 'd', personId: 'p' });
  vi.mocked(push.browserPushEnabled).mockResolvedValue(true);
  show();
  expect(await screen.findByText('My phone — this device')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Approval requested' }));
  await waitFor(() =>
    expect(push.updatePushDevice).toHaveBeenCalledWith('d', {
      approvals: true,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
  await waitFor(() => expect(push.testPushDevice).toHaveBeenCalledWith('d'));
  expect(screen.getByText(/accepted by the Push service/)).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Remove this device' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove this device' }));
  await waitFor(() => expect(push.revokePushDevice).toHaveBeenCalledWith('d'));
});
it('does not load private device data or show mutations during impersonation', () => {
  session.data.impersonation = {
    sessionId: 's',
    administratorId: 'admin',
    administratorName: 'Admin',
    personId: 'p',
    personName: 'Person',
    expiresAt: Date.now() + 1000,
  };
  show();
  expect(screen.getByText(/outside impersonation mode/)).toBeInTheDocument();
  expect(push.readPushStatus).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).toBeNull();
});
