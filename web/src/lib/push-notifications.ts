import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface PushDevice {
  id: string;
  label: string;
  language: string;
  completed: boolean;
  approvals: boolean;
  questions: boolean;
  createdAt: number;
  updatedAt: number;
  lastTestStatus?: 'pending' | 'sent' | 'dropped' | null;
}
export interface PushStatus {
  configured: boolean;
  publicKey: string | null;
  devices: PushDevice[];
}
const STORAGE_KEY = 'mergeron-push-device-v1';
export function currentPushDevice(): { id: string; personId: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return typeof value?.id === 'string' && typeof value?.personId === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
export function pushSupported() {
  return (
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}
async function pushRequest<T>(
  path = '',
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/push${path}`), {
    method,
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    throw new Error(
      typeof value?.message === 'string' && /^push\w+$/.test(value.message)
        ? value.message
        : 'pushFailed',
    );
  }
  return response.json() as Promise<T>;
}
export const readPushStatus = () => pushRequest<PushStatus>();
export const updatePushDevice = (
  id: string,
  preferences: Partial<
    Pick<PushDevice, 'completed' | 'approvals' | 'questions'>
  >,
) =>
  pushRequest<PushDevice>(
    `/subscriptions/${encodeURIComponent(id)}`,
    'PATCH',
    preferences,
  );
export const testPushDevice = (id: string) =>
  pushRequest(`/subscriptions/${encodeURIComponent(id)}/test`, 'POST');

async function registration() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('pushWorkerUnavailable')),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function browserPushEnabled() {
  if (!pushSupported()) return false;
  const worker = await navigator.serviceWorker.getRegistration(
    withBasePath('/'),
  );
  return !!(await worker?.pushManager.getSubscription());
}
export function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const value = atob(
    key
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(key.length / 4) * 4, '='),
  );
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}
/** Called directly from the enable button: no network await before permission. */
export async function enablePush(
  personId: string,
  publicKey: string,
  label: string,
  language: string,
) {
  if (!pushSupported()) throw new Error('pushUnsupported');
  if (!label.trim() || label.trim().length > 80)
    throw new Error('pushInvalidDevice');
  try {
    localStorage.setItem('mergeron-push-check', '1');
    localStorage.removeItem('mergeron-push-check');
  } catch {
    throw new Error('pushLocalStorageUnavailable');
  }
  if ((await Notification.requestPermission()) !== 'granted')
    throw new Error('pushPermissionDenied');
  const worker = await registration();
  let subscription = await worker.pushManager.getSubscription();
  let created = false;
  if (!subscription) {
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidBytes(publicKey),
    });
    created = true;
  }
  try {
    const device = await pushRequest<PushDevice>('/subscriptions', 'POST', {
      subscription: subscription.toJSON(),
      label: label.trim(),
      language: language.startsWith('fr') ? 'fr' : 'en',
    });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: device.id, personId }),
    );
    return device;
  } catch (error) {
    if (created) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}
export async function revokePushDevice(id: string) {
  await pushRequest(`/subscriptions/${encodeURIComponent(id)}`, 'DELETE');
  if (currentPushDevice()?.id === id) await unsubscribeBrowserPush();
}
export async function unsubscribeBrowserPush() {
  if (pushSupported()) {
    const worker = await navigator.serviceWorker.getRegistration(
      withBasePath('/'),
    );
    const subscription = await worker?.pushManager.getSubscription();
    if (subscription && !(await subscription.unsubscribe()))
      throw new Error('pushFailed');
  }
  localStorage.removeItem(STORAGE_KEY);
}
/** Logout revokes this browser too, never other devices. Do not prevent logout. */
export async function disconnectPushOnLogout() {
  const device = currentPushDevice();
  if (device)
    await pushRequest(
      `/subscriptions/${encodeURIComponent(device.id)}`,
      'DELETE',
    ).catch(() => undefined);
  await unsubscribeBrowserPush().catch(() => undefined);
}
