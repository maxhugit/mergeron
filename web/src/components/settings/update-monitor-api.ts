import { getAuthorizationHeader } from '@/auth-token';

/** Exchange an administrator-issued, short-lived grant for a path-scoped HttpOnly cookie. */
export async function prepareUpdateMonitor() {
  const authorization = getAuthorizationHeader();
  const grant = await fetch('/api/settings/manager/update/monitor', {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
  });
  if (!grant.ok) throw new Error('updateMonitorUnavailable');
  const data = (await grant.json()) as { token?: string };
  if (!/^[a-f0-9]{64}$/.test(data.token ?? ''))
    throw new Error('updateMonitorUnavailable');
  const session = await fetch('/_mergeron-update/session', {
    method: 'POST',
    body: data.token,
    credentials: 'same-origin',
  });
  if (!session.ok) throw new Error('updateMonitorUnavailable');
}
