import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Copy, ExternalLink } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { projectsApi } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import type { PreviewStorageStatus } from '../../../../runtime/preview-storage.cjs';
import { PreviewStorageSummary } from '../projects/preview-storage-summary';

export interface AgentPreview {
  state: string;
  url: string | null;
  sourcePath: string;
  error: string | null;
  expiresAt: number | null;
  lastSyncedAt: number | null;
  updateMode: string;
  requiresRestart: boolean;
  ready: boolean;
  storage?: PreviewStorageStatus | null;
}
export function AgentPreviewDialog({
  projectId,
  threadId,
  open,
  onOpenChange,
}: {
  projectId: string;
  threadId: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const { t, i18n } = useTranslation('previews');
  const session = usePlatformSession(),
    client = useQueryClient();
  const [showLogs, setShowLogs] = useState(false),
    [openError, setOpenError] = useState('');
  const addressId = useId();
  const [copyResult, setCopyResult] = useState<{
    url: string;
    status: 'copied' | 'failed';
  } | null>(null);
  const prefix = `/${projectId}/agents/${threadId}/preview`,
    key = ['agent-preview', projectId, threadId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => projectsApi<{ preview: AgentPreview | null }>(prefix),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
  const logs = useQuery({
    queryKey: [...key, 'logs'],
    queryFn: () => projectsApi<{ text: string }>(prefix + '/logs'),
    enabled: open && showLogs && !!query.data?.preview,
    refetchInterval: showLogs ? 5000 : false,
  });
  const mutation = useMutation({
    mutationFn: (operation: 'start' | 'sync' | 'refresh' | 'stop') =>
      projectsApi(prefix + '/' + operation, {
        method: 'POST',
        body: JSON.stringify({ requestId: crypto.randomUUID() }),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const preview = query.data?.preview,
    active = preview?.state === 'running';
  const address = (() => {
    if (!active || !preview.ready || query.isError || !preview.url) return null;
    try {
      const url = new URL(preview.url);
      // Display/copy the stable address, never the short-lived access grant.
      return url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.hash
        ? url.href
        : null;
    } catch {
      return null;
    }
  })();
  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopyResult({ url: address, status: 'copied' });
    } catch {
      setCopyResult({ url: address, status: 'failed' });
    }
  };
  const openPreview = async () => {
    if (!address) return;
    setOpenError('');
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setOpenError(t('popupBlocked'));
      return;
    }
    tab.opener = null;
    try {
      const result = await projectsApi<{ url: string }>(prefix + '/open', {
        method: 'POST',
      });
      const url = new URL(result.url);
      if (
        url.origin !== new URL(address).origin ||
        url.pathname !== '/.__mergeron_preview/open' ||
        url.username ||
        url.password
      )
        throw Error(t('unavailable'));
      tab.location.replace(url.toString());
    } catch (e) {
      tab?.close();
      setOpenError(e instanceof Error ? e.message : t('unavailable'));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-h-[85dvh] grid-cols-1 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <p role="status" className="text-sm">
          {t('state')}:{' '}
          {query.isPending
            ? t('loading')
            : preview
              ? preview.state === 'running' && !preview.ready
                ? t('waitingForHttp')
                : ({
                    starting: t('states.starting'),
                    running: t('states.running'),
                    stopping: t('states.stopping'),
                    stopped: t('states.stopped'),
                    failed: t('states.failed'),
                  }[preview.state] ?? t('unavailable'))
              : t('notStarted')}
        </p>
        {query.isError && <p role="alert">{t('unavailable')}</p>}
        {address && (
          <section
            aria-labelledby={addressId + '-label'}
            className="min-w-0 space-y-2 rounded-lg border bg-muted/30 p-3"
          >
            <label
              id={addressId + '-label'}
              htmlFor={addressId}
              className="block text-sm font-medium"
            >
              {t('address')}
            </label>
            <Input
              id={addressId}
              value={address}
              readOnly
              className="min-w-0 font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void openPreview()}>
                <ExternalLink aria-hidden="true" className="size-4" />
                {t('open')}
              </Button>
              <Button variant="outline" onClick={() => void copyAddress()}>
                <Copy aria-hidden="true" className="size-4" />
                {t('copyAddress')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('addressHelp')}</p>
            {copyResult?.url === address && (
              <p
                role={copyResult.status === 'copied' ? 'status' : 'alert'}
                className="text-xs"
              >
                {t(
                  copyResult.status === 'copied'
                    ? 'addressCopied'
                    : 'copyFailed',
                )}
              </p>
            )}
          </section>
        )}
        {preview && (
          <>
            <p className="break-all text-xs text-muted-foreground">
              {t('source')}: {preview.sourcePath}
            </p>
            {preview.storage && <PreviewStorageSummary {...preview.storage} />}
            {preview.lastSyncedAt && (
              <p className="text-xs">
                {t('lastSync')}:{' '}
                {new Intl.DateTimeFormat(i18n.language, {
                  timeStyle: 'medium',
                }).format(preview.lastSyncedAt)}
              </p>
            )}
            {preview.expiresAt && (
              <p className="text-xs">
                {t('expiry')}:{' '}
                {new Intl.DateTimeFormat(i18n.language, {
                  timeStyle: 'short',
                }).format(preview.expiresAt)}
              </p>
            )}
            {preview.requiresRestart && (
              <p
                role="status"
                className="rounded border border-amber-500 p-2 text-sm"
              >
                {t('dependenciesChanged')}
              </p>
            )}
            {preview.error && (
              <p role="alert" className="text-sm text-destructive">
                {preview.error}
              </p>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {session.isAdministrator &&
            (!preview || preview.state === 'stopped') && (
              <Button
                disabled={mutation.isPending}
                onClick={() => mutation.mutate('start')}
              >
                {t('startButton')}
              </Button>
            )}
          {session.isAdministrator && active && (
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate('sync')}
            >
              {t('sync')}
            </Button>
          )}
          {session.isAdministrator && preview && (
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => {
                if (window.confirm(t('recreateConfirm')))
                  mutation.mutate('refresh');
              }}
            >
              {t('recreate')}
            </Button>
          )}
          {session.isAdministrator && active && (
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => {
                if (window.confirm(t('stopConfirm'))) mutation.mutate('stop');
              }}
            >
              {t('stop')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('hotHelp')}</p>
        {(mutation.isError || openError) && (
          <p role="alert" className="text-sm text-destructive">
            {openError || mutation.error?.message}
          </p>
        )}
        {preview && (
          <>
            <Button
              variant="ghost"
              className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5"
              onClick={() => setShowLogs((v) => !v)}
            >
              {t('logs')}
            </Button>
            {showLogs && (
              <pre
                aria-label={t('logs')}
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-3 text-xs"
              >
                {logs.data?.text ??
                  (logs.isError ? t('unavailable') : t('loading'))}
              </pre>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
