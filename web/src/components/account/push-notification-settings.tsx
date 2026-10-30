import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePlatformSession } from '@/lib/platform-session';
import {
  browserPushEnabled,
  currentPushDevice,
  enablePush,
  pushSupported,
  readPushStatus,
  revokePushDevice,
  testPushDevice,
  unsubscribeBrowserPush,
  updatePushDevice,
} from '@/lib/push-notifications';

export function PushNotificationSettings() {
  const { t, i18n } = useTranslation('pwa');
  const session = usePlatformSession().data;
  const eligible =
    session?.kind === 'person' &&
    session.active &&
    !!session.role &&
    !session.impersonation;
  const status = useQuery({
    queryKey: ['push-devices', session?.personId],
    queryFn: readPushStatus,
    enabled: eligible,
    refetchInterval: 5000,
  });
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [label, setLabel] = useState('');
  useEffect(() => {
    void browserPushEnabled()
      .then(setEnabled)
      .catch(() => setEnabled(false));
  }, []);
  const local = currentPushDevice();
  const current =
    local?.personId === session?.personId
      ? status.data?.devices.find((device) => device.id === local?.id)
      : undefined;
  const supported = pushSupported();
  const perform = async (action: () => Promise<unknown>, success = '') => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      const key = error instanceof Error ? error.message : '';
      setMessage(
        t(
          [
            'pushPermissionDenied',
            'pushDeviceAlreadyLinked',
            'pushWorkerUnavailable',
            'pushLocalStorageUnavailable',
            'pushDeviceLimit',
            'pushTestRateLimited',
            'pushInvalidDevice',
          ].includes(key)
            ? key
            : 'pushFailed',
        ),
      );
    } finally {
      await status.refetch().catch(() => undefined);
      await browserPushEnabled()
        .then(setEnabled)
        .catch(() => setEnabled(false));
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-label={t('pushTitle')}
    >
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Bell className="h-4 w-4" />
        {t('pushTitle')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('pushDescription')}</p>
      {!eligible ? (
        <p className="text-sm">{t('pushPersonalAccountRequired')}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t('pushAvailability')}
          </p>
          {!supported && (
            <p role="status" className="text-sm">
              {t('pushUnsupported')}
            </p>
          )}
          {supported && Notification.permission === 'denied' && (
            <p className="text-sm">{t('pushPermissionDenied')}</p>
          )}
          {status.data && !status.data.configured && (
            <p role="status" className="text-sm">
              {t('pushNotConfigured')}
            </p>
          )}
          {status.isError && (
            <p role="alert" className="text-sm">
              {t('pushFailed')}
            </p>
          )}
          {current &&
          enabled &&
          supported &&
          Notification.permission === 'granted' ? (
            <p className="text-sm">{t('pushThisDeviceEnabled')}</p>
          ) : (
            <div className="space-y-2">
              <label className="block space-y-1 text-sm">
                <span>{t('pushDeviceName')}</span>
                <Input
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('pushDevicePlaceholder')}
                  disabled={busy}
                />
              </label>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !supported ||
                  !status.data?.configured ||
                  !label.trim() ||
                  Notification.permission === 'denied'
                }
                onClick={() => {
                  // No await before enablePush's permission request in this gesture.
                  void perform(() =>
                    enablePush(
                      session.personId!,
                      status.data!.publicKey!,
                      label,
                      i18n.resolvedLanguage ?? i18n.language,
                    ),
                  );
                }}
              >
                {t('pushEnable')}
              </Button>
            </div>
          )}
          {enabled && !current && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void perform(unsubscribeBrowserPush)}
            >
              {t('pushResetBrowser')}
            </Button>
          )}
          <ul className="space-y-3">
            {status.data?.devices.map((device) => (
              <li
                key={device.id}
                className="space-y-2 rounded-lg border border-border p-3 text-sm"
              >
                <p className="break-words font-medium">
                  {device.label}
                  {device.id === current?.id ? ` — ${t('pushThisDevice')}` : ''}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {(['completed', 'approvals', 'questions'] as const).map(
                    (kind) => (
                      <label key={kind} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={device[kind]}
                          disabled={busy}
                          onChange={(event) =>
                            void perform(() =>
                              updatePushDevice(device.id, {
                                [kind]: event.target.checked,
                              }),
                            )
                          }
                        />
                        {t(
                          kind === 'completed'
                            ? 'pushCompleted'
                            : kind === 'approvals'
                              ? 'pushApprovals'
                              : 'pushQuestions',
                        )}
                      </label>
                    ),
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !status.data?.configured}
                    onClick={() =>
                      void perform(
                        () => testPushDevice(device.id),
                        t('pushTestQueued'),
                      )
                    }
                  >
                    {t('pushTest')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void perform(() => revokePushDevice(device.id))
                    }
                  >
                    {t('pushRevoke')}
                  </Button>
                </div>
                {device.lastTestStatus && (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      device.lastTestStatus === 'pending'
                        ? 'pushTestPending'
                        : device.lastTestStatus === 'sent'
                          ? 'pushTestSent'
                          : 'pushTestDropped',
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
