import { translationKey } from '@/locales/translation-key';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

import {
  useServerCapabilities,
  requestCapabilities,
  capabilitiesKey,
  type Capability,
} from './server-capabilities-api';
export function ServerCapabilities() {
  const { t, i18n } = useTranslation('manager');
  const language = i18n.resolvedLanguage?.split('-')[0] ?? 'en';
  const query = useServerCapabilities();
  const client = useQueryClient();
  const [choice, setChoice] = useState<Capability | null>(null);
  const [action, setAction] = useState<'install' | 'uninstall'>('install');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function confirm() {
    if (!choice) return;
    setPending(true);
    setFailed(false);
    try {
      await requestCapabilities({
        id: choice.id,
        action,
        confirmation: `${action}:${choice.id}`,
      });
      setChoice(null);
      await client.invalidateQueries({ queryKey: capabilitiesKey });
      await client.invalidateQueries({ queryKey: ['transcription-status'] });
      await client.invalidateQueries({
        queryKey: ['administration', 'manager-status'],
      });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t('capabilitiesTitle')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('capabilitiesDescription')}
      </p>
      {(query.isError || query.data?.error || failed) && (
        <p role="alert">{t('capabilitiesError')}</p>
      )}
      {query.isPending && <p role="status">{t('capabilitiesLoading')}</p>}
      {query.data?.capabilities.map((c) => (
        <article
          key={c.id}
          className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
        >
          <div className="min-w-0 space-y-1">
            <h3 className="font-medium">
              {c.title?.[language] ??
                c.title?.en ??
                t(
                  c.id === 'browser'
                    ? 'capabilityBrowser'
                    : 'capabilityTranscription',
                )}
            </h3>
            <p className="text-sm text-muted-foreground">
              {c.description?.[language] ??
                c.description?.en ??
                t(
                  c.id === 'browser'
                    ? 'capabilityBrowserDescription'
                    : 'capabilityTranscriptionDescription',
                )}
            </p>
            <p role="status" className="text-sm">
              {t(translationKey(`capabilityStates.${c.state}`), {
                defaultValue: t('capabilityStates.error'),
              })}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={!!query.data?.operation || pending || c.activeLeases > 0}
            onClick={() => {
              setFailed(false);
              setAction(c.installed ? 'uninstall' : 'install');
              setChoice(c);
            }}
          >
            {t(c.installed ? 'capabilityUninstall' : 'capabilityInstall')}
          </Button>
          {c.installed && ['missing', 'error'].includes(c.state) && (
            <Button
              variant="outline"
              disabled={
                !!query.data?.operation || pending || c.activeLeases > 0
              }
              onClick={() => {
                setFailed(false);
                setAction('install');
                setChoice(c);
              }}
            >
              {t('capabilityInstall')}
            </Button>
          )}
          {c.activeLeases > 0 && (
            <p className="text-sm">{t('capabilityInUse')}</p>
          )}
        </article>
      ))}
      <Dialog
        open={!!choice}
        onOpenChange={(open) => {
          if (!open && !pending) setChoice(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                action === 'install'
                  ? 'capabilityInstall'
                  : 'capabilityUninstall',
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                action === 'install'
                  ? 'capabilityInstallConfirm'
                  : 'capabilityUninstallConfirm',
              )}
            </DialogDescription>
          </DialogHeader>
          <Button disabled={pending} onClick={() => void confirm()}>
            {t('capabilityConfirm')}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
