import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  ExternalLink,
  FlaskConical,
  HardDrive,
  Play,
  RotateCw,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { projectsApi } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import { PreviewStorageMeters } from '../projects/preview-storage-meters';
import type { AgentPreview } from './agent-preview-dialog';

const ContainerTerminal = lazy(() =>
  import('./preview-container-terminal').then((m) => ({
    default: m.PreviewContainerTerminal,
  })),
);
export interface PreviewContainer {
  component: string;
  name: string;
  image: string;
  state: string;
  startedAt: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  terminalAvailable: boolean;
}
export function AgentPreviewPanel({
  projectId,
  threadId,
  active,
}: {
  projectId: string;
  threadId: string;
  active: boolean;
}) {
  const { t, i18n } = useTranslation('previews');
  const session = usePlatformSession(),
    client = useQueryClient();
  const [storageVisible, setStorageVisible] = useState(false);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'logs' | 'terminal'>('logs');
  const [terminalBinding, setTerminalBinding] = useState('');
  const [duration, setDuration] = useState<number | null | undefined>();
  const [notice, setNotice] = useState('');
  const prefix = `/${projectId}/agents/${threadId}/preview`,
    key = ['agent-preview', projectId, threadId];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      projectsApi<{
        preview: (AgentPreview & { runId: string }) | null;
        defaultLifetimeMinutes?: number | null;
      }>(prefix),
    enabled: active,
    refetchInterval: active ? 3000 : false,
  });
  const preview = query.data?.preview;
  const running = preview?.state === 'running';
  const present =
    !!preview &&
    ['running', 'starting', 'failed', 'stopping'].includes(preview.state);
  const runId = preview?.runId;
  const containers = useQuery({
    queryKey: [...key, 'containers', runId],
    queryFn: () =>
      projectsApi<{ containers: PreviewContainer[] }>(prefix + '/containers'),
    enabled: active && present && !query.isError,
    refetchInterval: active && running ? 5000 : false,
  });
  const items = containers.data?.containers ?? [];
  const item = items.find((c) => c.component === selected) ?? items[0];
  const consoleMode =
    mode === 'terminal' && terminalBinding === `${runId}:${item?.component}`
      ? 'terminal'
      : 'logs';
  const logs = useQuery({
    queryKey: [...key, 'container-logs', runId, item?.component],
    queryFn: () =>
      projectsApi<{ text: string }>(
        prefix +
          '/container-logs?component=' +
          encodeURIComponent(item!.component),
      ),
    enabled:
      active && present && !!item && consoleMode === 'logs' && !query.isError,
    refetchInterval: active && consoleMode === 'logs' && running ? 3000 : false,
  });
  const chosenDuration =
    duration === undefined
      ? preview?.lifetimeMinutes === undefined
        ? query.data?.defaultLifetimeMinutes === undefined
          ? 300
          : query.data.defaultLifetimeMinutes
        : preview.lifetimeMinutes
      : duration;
  const operation = useMutation({
    mutationFn: (action: 'start' | 'stop' | 'refresh' | 'sync') =>
      projectsApi(prefix + '/' + action, {
        method: 'POST',
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          lifetimeMinutes: chosenDuration,
        }),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const lifetime = useMutation({
    mutationFn: (value: number | null) =>
      projectsApi(prefix + '/lifetime', {
        method: 'PUT',
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          lifetimeMinutes: value,
        }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      setDuration(undefined);
    },
    onError: () => setDuration(undefined),
  });
  const busy =
    query.isPending ||
    query.isError ||
    operation.isPending ||
    lifetime.isPending ||
    preview?.state === 'starting' ||
    preview?.state === 'stopping';
  let address: string | null = null;
  try {
    const url = new URL(preview?.url ?? '');
    if (
      running &&
      preview?.ready &&
      !query.isError &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash
    )
      address = url.href;
  } catch {
    /* No active address. */
  }
  const open = async () => {
    if (!address) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setNotice(t('popupBlocked'));
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
        throw Error();
      tab.location.replace(url.href);
    } catch {
      tab.close();
      setNotice(t('unavailable'));
    }
  };
  const state = query.isPending
    ? t('loading')
    : preview?.state === 'running' && !preview.ready
      ? t('waitingForHttp')
      : preview
        ? ({
            starting: t('states.starting'),
            running: t('states.running'),
            stopping: t('states.stopping'),
            stopped: t('states.stopped'),
            failed: t('states.failed'),
          }[preview.state] ?? t('unavailable'))
        : t('notStarted');
  return (
    <section
      aria-label={t('title')}
      className="@container flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <label className="flex items-center gap-2 text-xs">
          {t('lifetime')}
          <select
            aria-label={t('lifetime')}
            className="h-8 min-w-0 rounded border bg-background px-2"
            value={chosenDuration === null ? 'never' : String(chosenDuration)}
            disabled={!session.isAdministrator || busy}
            onChange={(e) => {
              const value =
                e.target.value === 'never' ? null : Number(e.target.value);
              setDuration(value);
              if (running) lifetime.mutate(value);
            }}
          >
            {chosenDuration !== null &&
              ![60, 180, 300, 600, 1440].includes(chosenDuration) && (
                <option value={chosenDuration}>
                  {t('legacyLifetime', { minutes: chosenDuration })}
                </option>
              )}
            {[60, 180, 300, 600, 1440].map((minutes) => (
              <option key={minutes} value={minutes}>
                {t('lifetimeHours', { count: minutes / 60 })}
              </option>
            ))}
            <option value="never">{t('never')}</option>
          </select>
        </label>
        {session.isAdministrator && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (running && !window.confirm(t('stopConfirm'))) return;
                setMode('logs');
                operation.mutate(
                  running
                    ? 'stop'
                    : preview?.state === 'failed'
                      ? 'refresh'
                      : 'start',
                );
              }}
            >
              {running ? (
                <Square className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
              {t(running ? 'stop' : 'startButton')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !preview}
              onClick={() => {
                if (window.confirm(t('recreateConfirm'))) {
                  setMode('logs');
                  operation.mutate('refresh');
                }
              }}
            >
              <RotateCw className="size-4" />
              {t('recreate')}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          aria-pressed={storageVisible}
          disabled={!present}
          onClick={() => setStorageVisible((v) => !v)}
        >
          <HardDrive className="size-4" />
          {t('storageToggle')}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!address}
            onClick={() => void open()}
          >
            <ExternalLink className="size-4" />
            {t('open')}
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={!address}
            aria-label={t('copyAddress')}
            onClick={() => {
              if (address)
                void navigator.clipboard
                  .writeText(address)
                  .then(() => setNotice(t('addressCopied')))
                  .catch(() => setNotice(t('copyFailed')));
            }}
          >
            <Copy className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="min-w-0 break-all text-muted-foreground">
          {address ?? t('noActiveUrl')}
        </span>
        <span role="status" className="rounded bg-muted px-2 py-0.5">
          {state}
        </span>
        {preview?.expiresAt && (
          <span className="ml-auto text-muted-foreground">
            {t('expiry')}:{' '}
            {new Date(preview.expiresAt).toLocaleTimeString(i18n.language, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>
      {(query.isError ||
        operation.isError ||
        lifetime.isError ||
        preview?.error) && (
        <p role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">
          {operation.error?.message ||
            lifetime.error?.message ||
            (preview?.error === 'PREVIEW_STARTUP_TIMEOUT'
              ? t('startupTimeout')
              : preview?.error) ||
            t('unavailable')}
        </p>
      )}
      {notice && (
        <p role="status" className="shrink-0 px-3 py-1 text-xs">
          {notice}
        </p>
      )}
      {!present && !query.isPending && !query.isError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <FlaskConical className="size-6" />
          <h3 className="font-medium text-foreground">{t('emptyTitle')}</h3>
          <p>{t(session.isAdministrator ? 'emptyHelp' : 'emptyReadOnly')}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
          {storageVisible && preview?.storage && (
            <PreviewStorageMeters storage={preview.storage} />
          )}
          {preview?.requiresRestart && (
            <p role="status" className="shrink-0 text-xs">
              {t('dependenciesChanged')}
            </p>
          )}
          <section aria-label={t('containers')} className="shrink-0">
            <h3 className="mb-1 text-sm font-medium">
              {t('containers')} ({items.length})
            </h3>
            {containers.isError ? (
              <p role="alert" className="text-xs">
                {t('containersUnavailable')}
              </p>
            ) : (
              <div
                className="max-h-[216px] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
                aria-label={t('containerList')}
              >
                <div className="sticky top-0 z-10 grid h-6 grid-cols-[minmax(0,1fr)_80px] items-center gap-3 bg-background px-2 text-xs text-muted-foreground @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_64px_80px]">
                  <span>{t('container')}</span>
                  <span className="hidden @xl:block">{t('image')}</span>
                  <span className="hidden @xl:block">CPU</span>
                  <span className="text-right">{t('containerMemory')}</span>
                </div>
                {items.map((c) => (
                  <button
                    key={c.component}
                    type="button"
                    aria-pressed={item?.component === c.component}
                    onClick={() => {
                      setSelected(c.component);
                      setMode('logs');
                    }}
                    className={
                      'grid h-16 w-full grid-cols-[minmax(0,1fr)_80px] items-center gap-3 rounded px-2 text-left text-xs @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_64px_80px] ' +
                      (item?.component === c.component
                        ? 'bg-accent'
                        : 'hover:bg-muted')
                    }
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {c.name}
                      </span>
                      <span className="block truncate text-muted-foreground">
                        {c.state}
                        {c.startedAt && Number.isFinite(Date.parse(c.startedAt))
                          ? ' · ' +
                            new Date(c.startedAt).toLocaleTimeString(
                              i18n.language,
                              { hour: '2-digit', minute: '2-digit' },
                            )
                          : ''}
                      </span>
                    </span>
                    <span
                      title={c.image}
                      className="hidden truncate font-mono text-muted-foreground @xl:block"
                    >
                      {c.image}
                    </span>
                    <span className="hidden tabular-nums @xl:block">
                      {c.cpuPercent === null
                        ? '—'
                        : c.cpuPercent.toFixed(1) + ' %'}
                    </span>
                    <span className="text-right tabular-nums">
                      {c.memoryBytes === null
                        ? '—'
                        : Math.round(c.memoryBytes / 1024 ** 2) + ' MiB'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
          <section
            aria-label={t('containerConsole')}
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
          >
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {item?.name ?? t('containers')}
              </span>
              <Button
                size="sm"
                variant={consoleMode === 'logs' ? 'secondary' : 'ghost'}
                aria-pressed={consoleMode === 'logs'}
                onClick={() => setMode('logs')}
              >
                {t('containerLogs')}
              </Button>
              {session.isAdministrator && (
                <Button
                  size="sm"
                  variant={consoleMode === 'terminal' ? 'secondary' : 'ghost'}
                  aria-pressed={consoleMode === 'terminal'}
                  disabled={
                    !item?.terminalAvailable || !running || query.isError
                  }
                  onClick={() => {
                    setTerminalBinding(`${runId}:${item?.component}`);
                    setMode('terminal');
                  }}
                >
                  {t('containerTerminal')}
                </Button>
              )}
            </div>
            {active &&
            consoleMode === 'terminal' &&
            running &&
            item?.terminalAvailable &&
            runId &&
            !query.isError ? (
              <Suspense
                fallback={<p className="p-3 text-xs">{t('loading')}</p>}
              >
                <ContainerTerminal
                  key={runId + item.component}
                  prefix={prefix}
                  runId={runId}
                  component={item.component}
                />
              </Suspense>
            ) : (
              <pre
                aria-label={t('containerLogs')}
                className="min-h-0 flex-1 overflow-auto overscroll-contain whitespace-pre-wrap break-all bg-muted/20 p-3 font-mono text-xs"
              >
                {logs.isError
                  ? t('unavailable')
                  : (logs.data?.text ?? (running ? t('loading') : state))}
              </pre>
            )}
          </section>
          <div className="flex shrink-0 items-center gap-2">
            {preview?.lastSyncedAt && (
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {t('lastSync')}:{' '}
                {new Date(preview.lastSyncedAt).toLocaleTimeString(
                  i18n.language,
                )}
              </p>
            )}
            {running &&
              preview?.updateMode === 'manual' &&
              session.isAdministrator && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => operation.mutate('sync')}
                >
                  <RotateCw className="size-3" />
                  {t('sync')}
                </Button>
              )}
          </div>
        </div>
      )}
    </section>
  );
}
