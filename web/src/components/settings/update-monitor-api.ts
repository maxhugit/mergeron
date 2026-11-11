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

/** Reopening progress must work even when this browser did not start the update. */
export async function ensureUpdateMonitor() {
  const response = await fetch('/_mergeron-update/status', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (
    response.ok &&
    response.headers.get('content-type')?.includes('application/json')
  )
    return;
  if (response.status !== 401) throw new Error('updateMonitorUnavailable');
  await prepareUpdateMonitor();
}

/** Read only the independent endpoint; never mint a grant while identity is paused. */
export async function discoverRunningUpdate(
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch('/_mergeron-update/status', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    signal,
  });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    return null;
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('operation' in data)) return null;
  const operation = data.operation;
  if (
    !operation ||
    typeof operation !== 'object' ||
    !('status' in operation) ||
    operation.status !== 'running' ||
    !('id' in operation) ||
    typeof operation.id !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(operation.id)
  )
    return null;
  return operation.id;
}

export interface UpdateMonitorSnapshot {
  observedAt: string;
  operation: null | {
    id: string;
    phase: string;
    status:
      | 'running'
      | 'succeeded'
      | 'rolledBack'
      | 'recoveryRequired'
      | 'cancelled';
    checkpoint?: boolean;
    stages?: string[];
    events: { at: string; phase: string; status: string }[];
  };
}
const word = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));

/** Reject redirects/HTML/auth failures; never mistake a login page for progress. */
export async function readUpdateMonitor(
  signal: AbortSignal,
): Promise<UpdateMonitorSnapshot> {
  const response = await fetch('/_mergeron-update/status', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (response.status === 401)
    throw new Error('updateMonitorAuthenticationRequired');
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    throw new Error('updateMonitorUnavailable');
  const data = await response.json();
  if (!data || !timestamp(data.observedAt))
    throw new Error('updateMonitorUnavailable');
  const op = data.operation;
  if (op === null) return { observedAt: data.observedAt, operation: null };
  if (
    !op ||
    typeof op.id !== 'string' ||
    op.id.length < 1 ||
    op.id.length > 128 ||
    !word(op.phase) ||
    ![
      'running',
      'succeeded',
      'rolledBack',
      'recoveryRequired',
      'cancelled',
    ].includes(op.status) ||
    !Array.isArray(op.events)
  )
    throw new Error('updateMonitorUnavailable');
  return {
    observedAt: data.observedAt,
    operation: {
      id: op.id,
      phase: op.phase,
      status: op.status,
      ...(typeof op.checkpoint === 'boolean'
        ? { checkpoint: op.checkpoint }
        : {}),
      ...(Array.isArray(op.stages) &&
      op.stages.length > 0 &&
      op.stages.length <= 12 &&
      op.stages.every(word)
        ? { stages: [...op.stages] }
        : {}),
      events: op.events
        .slice(-200)
        .filter(
          (event: Record<string, unknown>) =>
            event &&
            timestamp(event.at) &&
            word(event.phase) &&
            word(event.status),
        )
        .map((event: { at: string; phase: string; status: string }) => ({
          at: event.at,
          phase: event.phase,
          status: event.status,
        })),
    },
  };
}
