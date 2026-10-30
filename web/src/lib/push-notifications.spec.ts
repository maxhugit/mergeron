import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  browserPushEnabled,
  currentPushDevice,
  disconnectPushOnLogout,
  enablePush,
  revokePushDevice,
  updatePushDevice,
  vapidBytes,
} from './push-notifications';

const device = { id: 'd', personId: 'person' };
let network: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let permission: ReturnType<typeof vi.fn>;
let subscription: {
  toJSON: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} | null;
beforeEach(() => {
  localStorage.clear();
  subscription = null;
  unsubscribe = vi.fn().mockResolvedValue(true);
  subscribe = vi.fn().mockImplementation(() => {
    subscription = {
      toJSON: vi.fn(() => ({
        endpoint: 'https://fcm.googleapis.com/secret',
        keys: { auth: 'secret', p256dh: 'key' },
      })),
      unsubscribe,
    };
    return Promise.resolve(subscription);
  });
  const worker = {
    pushManager: {
      getSubscription: vi.fn(() => Promise.resolve(subscription)),
      subscribe,
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(worker),
      getRegistration: vi.fn().mockResolvedValue(worker),
    },
  });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PushManager', class {});
  permission = vi.fn().mockResolvedValue('granted');
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: permission,
  });
  network = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(device), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});
it('requests permission in the original gesture, subscribes once with the VAPID key, and only stores a non-secret account/device ID', async () => {
  const task = enablePush('person', 'AQID', 'My phone', 'fr-FR');
  expect(permission).toHaveBeenCalledOnce();
  expect(network).not.toHaveBeenCalled();
  await task;
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from([1, 2, 3]),
  });
  expect(network.mock.calls[0][0]).toBe('/api/push/subscriptions');
  expect(JSON.parse(network.mock.calls[0][1].body)).toMatchObject({
    language: 'fr',
    label: 'My phone',
  });
  expect(currentPushDevice()).toEqual(device);
  expect(localStorage.getItem('mergeron-push-device-v1')).not.toContain(
    'secret',
  );
  await enablePush('person', 'AQID', 'My phone', 'en');
  expect(subscribe).toHaveBeenCalledOnce();
  expect(await browserPushEnabled()).toBe(true);
  expect([...vapidBytes('AQID')]).toEqual([1, 2, 3]);
});
it('does not contact the server or create a subscription if permission is refused', async () => {
  permission.mockResolvedValue('denied');
  await expect(enablePush('person', 'AQID', 'Phone', 'en')).rejects.toThrow(
    'pushPermissionDenied',
  );
  expect(network).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
});
it('unsubscribes a newly created capability if registration fails, without overwriting an existing account device', async () => {
  network.mockResolvedValue(
    new Response('{"message":"pushDeviceAlreadyLinked"}', { status: 409 }),
  );
  await expect(enablePush('person', 'AQID', 'Phone', 'en')).rejects.toThrow(
    'pushDeviceAlreadyLinked',
  );
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(currentPushDevice()).toBeNull();
});
it('scopes preference mutations and revoke to the selected device and unsubscribes the current browser on logout', async () => {
  await enablePush('person', 'AQID', 'Phone', 'en');
  network.mockImplementation(() => Promise.resolve(new Response('{}')));
  await updatePushDevice('d', { approvals: false });
  expect(network).toHaveBeenLastCalledWith(
    '/api/push/subscriptions/d',
    expect.objectContaining({
      method: 'PATCH',
      credentials: 'same-origin',
      redirect: 'error',
      body: '{"approvals":false}',
    }),
  );
  await revokePushDevice('other');
  expect(unsubscribe).not.toHaveBeenCalled();
  await disconnectPushOnLogout();
  expect(network).toHaveBeenLastCalledWith(
    '/api/push/subscriptions/d',
    expect.objectContaining({ method: 'DELETE' }),
  );
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(currentPushDevice()).toBeNull();
});
