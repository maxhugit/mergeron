import { useEffect, useState } from 'react';
import { translationKey } from '@/locales/translation-key';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { authRequest } from '@/lib/auth-api';
import { usePlatformSession } from '@/lib/platform-session';
import { resetSocket } from '@/socket';
import { reloadIdentity } from '@/lib/identity-switch';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function TestAsPersonButton({
  personId,
  name,
}: {
  personId: string;
  name: string;
}) {
  const { t } = useTranslation('authentication');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const start = async () => {
    if (!window.confirm(t('impersonation.confirm', { name }))) return;
    setBusy(true);
    setError(false);
    try {
      await authRequest('impersonation', {
        method: 'POST',
        body: JSON.stringify({ personId }),
      });
      reloadIdentity();
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void start()}
      >
        {t('impersonation.start')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('impersonation.error')}
        </p>
      )}
    </div>
  );
}

export function ImpersonationBanner() {
  const session = usePlatformSession();
  const context = session.data?.impersonation;
  const { t } = useTranslation('authentication');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === 'mergeron.identity-switch') {
        resetSocket();
        window.location.reload();
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  useEffect(() => {
    if (!context || context.expired) return;
    const timer = window.setTimeout(
      () => window.location.reload(),
      Math.max(0, context.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [context]);
  if (!context) return null;
  const stop = async () => {
    setBusy(true);
    setError(false);
    try {
      await authRequest('impersonation', { method: 'DELETE' });
      reloadIdentity();
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <section
      role="status"
      className="z-50 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-primary bg-primary/15 px-4 py-2 text-sm text-foreground"
    >
      <p>
        {t(context.expired ? 'impersonation.expired' : 'impersonation.banner', {
          name: context.personName,
          administrator: context.administratorName,
        })}
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void stop()}
      >
        {t('impersonation.stop')}
      </Button>
      {error && <p role="alert">{t('impersonation.error')}</p>}
    </section>
  );
}

export function ImpersonationAuditButton() {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('authentication');
  const audit = useQuery({
    queryKey: ['impersonation-audit'],
    enabled: open,
    queryFn: () =>
      authRequest<{
        events: Array<{
          id: string;
          administratorName: string;
          personName: string;
          action: string;
          method: string | null;
          route: string | null;
          createdAt: number;
        }>;
      }>('impersonation-audit'),
    staleTime: 0,
  });
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('impersonation.audit')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] max-w-4xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{t('impersonation.audit')}</DialogTitle>
          </DialogHeader>
          {audit.isError && <p role="alert">{t('impersonation.error')}</p>}
          {audit.isPending ? (
            <p>{t('impersonation.loading')}</p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t('impersonation.audit')}</caption>
              <thead>
                <tr>
                  {['date', 'administrator', 'person', 'action'].map((key) => (
                    <th className="p-2" key={key}>
                      {t(translationKey(`impersonation.${key}`))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {audit.data?.events.map((event) => (
                  <tr key={event.id} className="border-t">
                    <td className="p-2">
                      {new Date(event.createdAt).toLocaleString()}
                    </td>
                    <td className="p-2">{event.administratorName}</td>
                    <td className="p-2">{event.personName}</td>
                    <td className="break-all p-2">
                      {t(
                        translationKey(`impersonation.events.${event.action}`),
                        {
                          defaultValue: event.action,
                        },
                      )}{' '}
                      {event.method} {event.route}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
