import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BellRing,
  Clock,
  History,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  monitorPath,
  readMonitorHistory,
  type AgentMonitor,
  type MonitorListing,
} from '@/lib/agent-monitors-api';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';

const localDate = (time: number) => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const defaults = () => ({
  requestId: crypto.randomUUID(),
  threadId: '',
  name: '',
  instructions: '',
  runAt: localDate(Date.now() + 60_000),
  expiresAt: localDate(Date.now() + 86_400_000),
  recurring: true,
  intervalMinutes: 5,
  maxRuns: 20,
  maxRunMinutes: 5,
  workspaceWrite: false,
});
const selectStyle =
  'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm';
const reasonKeys: Record<string, string> = {
  MONITOR_AGENT_LIMIT: 'reasons.agentLimit',
  MONITOR_THREAD_CAPACITY: 'reasons.threadCapacity',
  MONITOR_USER_TAKEOVER: 'reasons.userTakeover',
  MONITOR_AGENT_BUSY: 'reasons.agentBusy',
  MONITOR_POLICY_EXCEEDS_GRANT: 'reasons.policyExceedsGrant',
  MONITOR_POLICY_UNKNOWN: 'reasons.policyUnknown',
  MONITOR_ENGINE_UNAVAILABLE: 'reasons.engineUnavailable',
  MONITOR_APPROVAL_REQUIRED: 'reasons.approvalRequired',
  MONITOR_ACCESS_REVOKED: 'reasons.accessRevoked',
  MONITOR_TIMEOUT: 'reasons.timeout',
  MONITOR_DISPATCH_UNCERTAIN: 'reasons.dispatchUncertain',
  MONITOR_STOP_UNCONFIRMED: 'reasons.stopUnconfirmed',
  MONITOR_ENGINE_RESTART: 'reasons.engineRestart',
  MONITOR_BACKEND_RESTART: 'reasons.backendRestart',
  MONITOR_EXPIRED: 'reasons.expired',
  MONITOR_RUN_LIMIT: 'reasons.runLimit',
  MONITOR_LIMIT_REACHED: 'reasons.limitReached',
  MONITOR_ALREADY_RUNNING: 'reasons.alreadyRunning',
  MONITOR_REQUEST_CONFLICT: 'reasons.requestConflict',
  MONITOR_INVALID_REQUEST: 'reasons.invalidRequest',
  MONITOR_INVALID_SCHEDULE: 'reasons.invalidSchedule',
  MONITOR_CAPACITY: 'reasons.capacity',
  MONITOR_TURN_INTERRUPTED: 'reasons.turnInterrupted',
};
const statusKeys: Record<AgentMonitor['status'], string> = {
  active: 'statuses.active',
  paused: 'statuses.paused',
  completed: 'statuses.completed',
  expired: 'statuses.expired',
  exhausted: 'statuses.exhausted',
  needs_attention: 'statuses.needsAttention',
};
const runKeys: Record<string, string> = {
  claimed: 'runs.claimed',
  dispatching: 'runs.dispatching',
  running: 'runs.running',
  completed: 'runs.completed',
  failed: 'runs.failed',
  deferred: 'runs.deferred',
  uncertain: 'runs.uncertain',
};

export function ProjectAgentMonitors({ projectId }: { projectId: string }) {
  const { t } = useTranslation('monitors');
  const { data: identity, isAdministrator } = usePlatformSession();
  const allowed =
    isAdministrator && identity?.kind === 'person' && !identity.impersonation;
  const client = useQueryClient();
  const key = ['agent-monitors', projectId];
  const listing = useQuery({
    queryKey: key,
    queryFn: () => projectsApi<MonitorListing>(monitorPath(projectId)),
    enabled: allowed,
    refetchInterval: 15_000,
  });
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
    enabled: allowed,
    staleTime: 30_000,
  });
  const agents =
    projects.data?.projects
      .find((project) => project.id === projectId)
      ?.agentThreads?.filter((agent) => !agent.archived) ?? [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(defaults);
  const [selected, setSelected] = useState<AgentMonitor | null>(null);
  const history = useQuery({
    queryKey: [...key, 'history', selected?.id],
    queryFn: () => readMonitorHistory(projectId, selected!.id),
    enabled: allowed && Boolean(selected),
    refetchInterval: selected ? 15_000 : false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: () =>
      projectsApi(monitorPath(projectId), {
        method: 'POST',
        body: JSON.stringify({
          requestId: draft.requestId,
          threadId: draft.threadId,
          name: draft.name,
          instructions: draft.instructions,
          runAt: new Date(draft.runAt).getTime(),
          expiresAt: new Date(draft.expiresAt).getTime(),
          intervalMs: draft.recurring ? draft.intervalMinutes * 60_000 : null,
          maxRuns: draft.maxRuns,
          maxRunMs: draft.maxRunMinutes * 60_000,
          accessMode: draft.workspaceWrite ? 'workspaceWrite' : 'readOnly',
        }),
      }),
    onSuccess: () => {
      setOpen(false);
      void refresh();
    },
  });
  const action = useMutation({
    mutationFn: ({
      id,
      operation,
    }: {
      id: string;
      operation: 'pause' | 'resume' | 'stop' | 'delete';
    }) =>
      projectsApi(
        `${monitorPath(projectId, id)}${operation === 'delete' ? '' : `/${operation}`}`,
        { method: operation === 'delete' ? 'DELETE' : 'POST' },
      ),
    onSuccess: refresh,
  });
  const reason = (code: string | null) =>
    code ? t(reasonKeys[code] ?? 'unknownReason') : '';
  const error = (value: Error | null) =>
    reason(value?.message ?? null) || t('error');
  const date = (value: number | null) =>
    value ? new Date(value).toLocaleString() : '—';
  if (!allowed)
    return (
      <p className="p-6 text-sm text-muted-foreground">{t('adminOnly')}</p>
    );
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 md:p-6"
      aria-label={t('title')}
    >
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <BellRing className="h-5 w-5 shrink-0" />
            {t('title')}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label={t('refresh')}
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            disabled={!agents.length || projects.isError}
            onClick={() => {
              save.reset();
              setDraft({ ...defaults(), threadId: agents[0]?.threadId ?? '' });
              setOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('create')}
          </Button>
        </div>
      </div>
      <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        {t('humanPriority')}
      </p>
      <p className="text-xs text-muted-foreground">{t('agentLimits')}</p>
      {(listing.isError || projects.isError || action.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {error(action.error ?? listing.error ?? projects.error)}
        </p>
      )}
      {listing.isPending && <p role="status">{t('loading')}</p>}
      {listing.data?.monitors.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {t('empty')}
        </p>
      )}
      {listing.data?.monitors.map((monitor) => {
        const running = listing.data.activeRuns.some(
          (run) => run.monitorId === monitor.id,
        );
        const agent = agents.find((item) => item.threadId === monitor.threadId);
        return (
          <article key={monitor.id} className="min-w-0 rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="break-words font-semibold">{monitor.name}</h2>
                <Link
                  to="/t/$threadId"
                  params={{ threadId: monitor.threadId }}
                  className="text-sm text-primary underline"
                >
                  {agent?.title || t('openAgent')}
                </Link>
              </div>
              <span className="rounded-full bg-muted px-2 py-1 text-xs">
                {t(statusKeys[monitor.status] ?? 'unknownReason')}
                {running ? ` · ${t('running')}` : ''}
              </span>
            </div>
            <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {monitor.instructions}
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t('next')}</dt>
                <dd>{date(monitor.nextRunAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t('expires')}
                </dt>
                <dd>{date(monitor.expiresAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('checks')}</dt>
                <dd>
                  {monitor.runCount} / {monitor.maxRuns} ·{' '}
                  {monitor.intervalMs === null
                    ? t('once')
                    : t('every', { count: monitor.intervalMs / 60_000 })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('access')}</dt>
                <dd>
                  {t(
                    monitor.accessMode === 'readOnly'
                      ? 'readOnly'
                      : 'workspaceWrite',
                  )}
                </dd>
              </div>
            </dl>
            {monitor.lastReason && (
              <p className="mt-3 text-sm text-muted-foreground">
                {reason(monitor.lastReason)}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelected(monitor)}
              >
                <History className="mr-2 h-4 w-4" />
                {t('history')}
              </Button>
              {monitor.status === 'active' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ id: monitor.id, operation: 'pause' })
                  }
                >
                  <Pause className="mr-2 h-4 w-4" />
                  {t('pause')}
                </Button>
              )}
              {['paused', 'needs_attention'].includes(monitor.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ id: monitor.id, operation: 'resume' })
                  }
                >
                  <Play className="mr-2 h-4 w-4" />
                  {t('resume')}
                </Button>
              )}
              {['active', 'paused', 'needs_attention'].includes(
                monitor.status,
              ) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={action.isPending}
                  title={t('stopHint')}
                  onClick={() =>
                    action.mutate({ id: monitor.id, operation: 'stop' })
                  }
                >
                  <Square className="mr-2 h-4 w-4" />
                  {t('stop')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={running || action.isPending}
                onClick={() => {
                  if (window.confirm(t('deleteConfirm')))
                    action.mutate({ id: monitor.id, operation: 'delete' });
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('delete')}
              </Button>
            </div>
          </article>
        );
      })}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto [--glass-modal-surface:var(--popover)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('create')}</DialogTitle>
            <DialogDescription>{t('formDescription')}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
              <label className="block space-y-1">
                <span>{t('agent')}</span>
                <select
                  className={selectStyle}
                  required
                  value={draft.threadId}
                  onChange={(event) =>
                    setDraft({ ...draft, threadId: event.target.value })
                  }
                >
                  {agents.map((agent) => (
                    <option key={agent.threadId} value={agent.threadId}>
                      {agent.title || t('untitledAgent')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span>{t('name')}</span>
                <Input
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <label className="block space-y-1">
                <span>{t('instructions')}</span>
                <Textarea
                  required
                  maxLength={6000}
                  rows={3}
                  value={draft.instructions}
                  onChange={(event) =>
                    setDraft({ ...draft, instructions: event.target.value })
                  }
                />
              </label>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <label className="min-w-0 space-y-1">
                  <span>{t('first')}</span>
                  <Input
                    className="min-w-0"
                    type="datetime-local"
                    required
                    value={draft.runAt}
                    onChange={(event) =>
                      setDraft({ ...draft, runAt: event.target.value })
                    }
                  />
                </label>
                <label className="min-w-0 space-y-1">
                  <span>{t('expires')}</span>
                  <Input
                    className="min-w-0"
                    type="datetime-local"
                    required
                    value={draft.expiresAt}
                    onChange={(event) =>
                      setDraft({ ...draft, expiresAt: event.target.value })
                    }
                  />
                </label>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.recurring}
                  onChange={(event) =>
                    setDraft({ ...draft, recurring: event.target.checked })
                  }
                />
                {t('recurring')}
              </label>
              <div className="grid min-w-0 gap-4 sm:grid-cols-3">
                {draft.recurring && (
                  <label className="min-w-0 space-y-1">
                    <span>{t('interval')}</span>
                    <Input
                      type="number"
                      required
                      min={1}
                      max={43200}
                      value={draft.intervalMinutes}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          intervalMinutes: event.target.valueAsNumber,
                        })
                      }
                    />
                  </label>
                )}
                <label className="min-w-0 space-y-1">
                  <span>{t('maxRuns')}</span>
                  <Input
                    type="number"
                    required
                    min={1}
                    max={100}
                    value={draft.maxRuns}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        maxRuns: event.target.valueAsNumber,
                      })
                    }
                  />
                </label>
                <label className="min-w-0 space-y-1">
                  <span>{t('maxDuration')}</span>
                  <Input
                    type="number"
                    required
                    min={0.5}
                    step={0.5}
                    max={30}
                    value={draft.maxRunMinutes}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        maxRunMinutes: event.target.valueAsNumber,
                      })
                    }
                  />
                </label>
              </div>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  checked={draft.workspaceWrite}
                  onChange={(event) =>
                    setDraft({ ...draft, workspaceWrite: event.target.checked })
                  }
                />
                <span>{t('writeGrant')}</span>
              </label>
              <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                {t('policyWarning')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('limitsWarning')}
              </p>
            </fieldset>
            {save.isError && (
              <p role="alert" className="text-sm text-destructive">
                {error(save.error)}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => setOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                <Clock className="mr-2 h-4 w-4" />
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(value) => {
          if (!value) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto [--glass-modal-surface:var(--popover)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('history')} — {selected?.name}
            </DialogTitle>
            <DialogDescription>{t('historyDescription')}</DialogDescription>
          </DialogHeader>
          {selected && (
            <p className="text-xs text-muted-foreground">
              {t('maxDuration')} : {selected.maxRunMs / 60_000} · {t('maxRuns')}{' '}
              : {selected.maxRuns}
            </p>
          )}
          {history.isError && <p role="alert">{error(history.error)}</p>}
          {history.isPending && <p>{t('loading')}</p>}
          {history.data?.runs.length === 0 && <p>{t('noHistory')}</p>}
          {history.data?.runs.map((run) => (
            <article
              key={run.id}
              className="min-w-0 space-y-2 rounded-lg border p-3"
            >
              <p className="text-sm font-medium">
                {t(runKeys[run.status] ?? 'unknownReason')} ·{' '}
                {date(run.claimedAt)}
              </p>
              {run.reason && (
                <p className="text-xs text-muted-foreground">
                  {reason(run.reason)}
                </p>
              )}
              {run.result && (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {run.result}
                </p>
              )}
            </article>
          ))}
        </DialogContent>
      </Dialog>
    </section>
  );
}
