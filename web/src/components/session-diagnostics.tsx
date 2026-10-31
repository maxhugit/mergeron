import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  clearSessionDiagnostics,
  exportSessionDiagnostics,
  getSessionDiagnostics,
  subscribeSessionDiagnostics,
  type SessionDiagnosticEvent,
  type SessionDiagnosticReason,
} from '@/lib/session-diagnostics';

export function SessionDiagnostics() {
  const { t } = useTranslation('authentication');
  const eventLabels = {
    paused: t('diagnostics.events.paused'),
    resumed: t('diagnostics.events.resumed'),
    check_started: t('diagnostics.events.checkStarted'),
    check_succeeded: t('diagnostics.events.checkSucceeded'),
    check_failed: t('diagnostics.events.checkFailed'),
    check_cancelled: t('diagnostics.events.checkCancelled'),
    retry_scheduled: t('diagnostics.events.retryScheduled'),
    response_discarded: t('diagnostics.events.responseDiscarded'),
    request_blocked: t('diagnostics.events.requestBlocked'),
    wake: t('diagnostics.events.wake'),
    offline: t('diagnostics.events.offline'),
    online: t('diagnostics.events.online'),
    manual_retry: t('diagnostics.events.manualRetry'),
    renewal_opened: t('diagnostics.events.renewalOpened'),
    renewal_blocked: t('diagnostics.events.renewalBlocked'),
    renewal_hint: t('diagnostics.events.renewalHint'),
  } satisfies Record<SessionDiagnosticEvent, string>;
  const reasonLabels = {
    verification: t('diagnostics.reasons.verification'),
    wake: t('diagnostics.reasons.wake'),
    proxy_redirect: t('diagnostics.reasons.proxyRedirect'),
    unauthorized: t('diagnostics.reasons.unauthorized'),
    forbidden: t('diagnostics.reasons.forbidden'),
    timeout: t('diagnostics.reasons.timeout'),
    rate_limited: t('diagnostics.reasons.rateLimited'),
    server_unavailable: t('diagnostics.reasons.serverUnavailable'),
    transport: t('diagnostics.reasons.transport'),
    invalid_response: t('diagnostics.reasons.invalidResponse'),
    identity_changed: t('diagnostics.reasons.identityChanged'),
    inactive: t('diagnostics.reasons.inactive'),
    superseded: t('diagnostics.reasons.superseded'),
  } satisfies Record<SessionDiagnosticReason, string>;
  const entries = useSyncExternalStore(
    subscribeSessionDiagnostics,
    getSessionDiagnostics,
  );
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([exportSessionDiagnostics()], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mergeron-session-diagnostic.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <details className="w-full min-w-0 space-y-2 text-left text-xs">
      <summary className="cursor-pointer font-medium">
        {t('diagnostics.title')}
      </summary>
      <p className="text-muted-foreground">{t('diagnostics.help')}</p>
      <div
        className="max-h-48 space-y-2 overflow-auto rounded-md border p-2"
        role="log"
        aria-live="off"
        aria-label={t('diagnostics.title')}
      >
        {entries.length === 0 && <p>{t('diagnostics.empty')}</p>}
        {entries.map((entry, index) => (
          <p key={index} className="break-words">
            <time dateTime={entry.at}>
              {new Date(entry.at).toLocaleTimeString()}
            </time>
            {' · '}
            {eventLabels[entry.event]}
            {entry.reason && <> · {reasonLabels[entry.reason]}</>}
            {entry.status !== undefined && <> · HTTP {entry.status}</>}
            {entry.durationMs !== undefined && <> · {entry.durationMs} ms</>}
            {entry.trigger && <> · {entry.trigger}</>}
            {entry.count > 1 && <> × {entry.count}</>}
          </p>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={download}>
          {t('diagnostics.download')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={clearSessionDiagnostics}
        >
          {t('diagnostics.clear')}
        </Button>
      </div>
    </details>
  );
}
