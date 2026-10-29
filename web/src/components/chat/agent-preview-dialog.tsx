import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { projectsApi } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';

export interface AgentPreview {
  state: string;
  url: string | null;
  sourcePath: string;
  error: string | null;
  expiresAt: number | null;
  lastSyncedAt: number | null;
  updateMode: string;
  requiresRestart: boolean;
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
  const openPreview = async () => {
    setOpenError('');
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const result = await projectsApi<{ url: string }>(prefix + '/open', {
        method: 'POST',
      });
      const url = new URL(result.url);
      if (url.protocol !== 'https:') throw Error(t('unavailable'));
      if (tab) tab.location.replace(url.toString());
      else throw Error(t('popupBlocked'));
    } catch (e) {
      tab?.close();
      setOpenError(e instanceof Error ? e.message : t('unavailable'));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <p role="status" className="text-sm">
          {t('state')}:{' '}
          {query.isPending
            ? t('loading')
            : preview
              ? ({
                  starting: t('states.starting'),
                  running: t('states.running'),
                  stopping: t('states.stopping'),
                  stopped: t('states.stopped'),
                  failed: t('states.failed'),
                }[preview.state] ?? t('unavailable'))
              : t('notStarted')}
        </p>
        {query.isError && <p role="alert">{t('unavailable')}</p>}
        {preview && (
          <>
            <p className="break-all text-xs text-muted-foreground">
              {t('source')}: {preview.sourcePath}
            </p>
            {preview.url && (
              <code className="block break-all rounded border p-2 text-xs">
                {preview.url}
              </code>
            )}
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
          {active && (
            <Button onClick={() => void openPreview()}>{t('open')}</Button>
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
            <Button variant="ghost" onClick={() => setShowLogs((v) => !v)}>
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
