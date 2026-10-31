/** Tab-local, bounded evidence, never an authorization input or a telemetry upload. */
export const SESSION_DIAGNOSTIC_LIMIT = 100;
const EVENTS = [
  'paused',
  'resumed',
  'check_started',
  'check_succeeded',
  'check_failed',
  'check_cancelled',
  'retry_scheduled',
  'response_discarded',
  'request_blocked',
  'wake',
  'offline',
  'online',
  'manual_retry',
  'renewal_opened',
  'renewal_blocked',
  'renewal_hint',
] as const;
const REASONS = [
  'verification',
  'wake',
  'proxy_redirect',
  'unauthorized',
  'forbidden',
  'timeout',
  'rate_limited',
  'server_unavailable',
  'transport',
  'invalid_response',
  'identity_changed',
  'inactive',
  'superseded',
] as const;
const TRIGGERS = [
  'focus',
  'pageshow',
  'online',
  'visibilitychange',
  'poll',
  'api_refusal',
] as const;
export type SessionDiagnosticEvent = (typeof EVENTS)[number];
export type SessionDiagnosticReason = (typeof REASONS)[number];
export interface SessionDiagnosticEntry {
  at: string;
  event: SessionDiagnosticEvent;
  reason?: SessionDiagnosticReason;
  trigger?: (typeof TRIGGERS)[number];
  generation?: number;
  status?: number;
  durationMs?: number;
  delayMs?: number;
  attempt?: number;
  online?: boolean;
  count: number;
}
type Details = Omit<SessionDiagnosticEntry, 'at' | 'event' | 'count'>;
let entries: readonly SessionDiagnosticEntry[] = [];
const listeners = new Set<() => void>();
const integer = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(max, Math.round(value)))
    : undefined;
export function recordSessionDiagnostic(
  event: SessionDiagnosticEvent,
  details: Details = {},
) {
  if (!EVENTS.includes(event)) return;
  // Explicit field selection: never spread an exception, request, identity or body.
  const row: SessionDiagnosticEntry = {
    at: new Date().toISOString(),
    event,
    count: 1,
    ...(REASONS.includes(details.reason!) ? { reason: details.reason } : {}),
    ...(TRIGGERS.includes(details.trigger!)
      ? { trigger: details.trigger }
      : {}),
  };
  for (const [key, max] of [
    ['generation', Number.MAX_SAFE_INTEGER],
    ['status', 599],
    ['durationMs', 86_400_000],
    ['delayMs', 60_000],
    ['attempt', 100],
  ] as const) {
    const value = integer(details[key], max);
    if (value !== undefined && (key !== 'status' || value >= 100))
      row[key] = value;
  }
  if (typeof details.online === 'boolean') row.online = details.online;
  const previous = entries.at(-1);
  const shape = (value: SessionDiagnosticEntry) =>
    JSON.stringify({ ...value, at: undefined, count: undefined });
  if (
    previous &&
    Date.parse(row.at) - Date.parse(previous.at) < 1000 &&
    shape(previous) === shape(row)
  )
    entries = [
      ...entries.slice(0, -1),
      { ...row, count: Math.min(previous.count + 1, 9999) },
    ];
  else entries = [...entries.slice(-(SESSION_DIAGNOSTIC_LIMIT - 1)), row];
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* Evidence must never break session verification. */
    }
  }
}
export const getSessionDiagnostics = () => entries;
export function subscribeSessionDiagnostics(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clearSessionDiagnostics() {
  entries = [];
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* Isolated UI subscriber. */
    }
  }
}
export function exportSessionDiagnostics() {
  // Asset basename only: no origin, path, search, page title or user-agent.
  let clientAsset: string | null = null;
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[src]',
  )) {
    try {
      const name = new URL(script.src).pathname.split('/').at(-1) ?? '';
      if (/^index-[A-Za-z0-9_-]{1,80}\.js$/.test(name)) clientAsset = name;
    } catch {
      /* A malformed script URL is not diagnostic evidence. */
    }
  }
  return JSON.stringify(
    {
      schemaVersion: 1,
      scope: 'this-tab-only',
      exportedAt: new Date().toISOString(),
      clientAsset,
      events: entries,
    },
    null,
    2,
  );
}
