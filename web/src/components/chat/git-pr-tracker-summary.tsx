import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  CircleCheck,
  CircleX,
  Bot,
  Pause,
  Clock,
  CircleAlert,
} from 'lucide-react';
import {
  gitGet,
  type GitChecks,
  type GitPullRequests,
} from '@/lib/workspace-git-api';
import { gitPrStatus } from '@/lib/git-pr-status';
import { GitPrAgentPicker } from './git-pr-agent-picker';

export function GitPrTrackerSummary({
  projectId,
  resourceId,
  pr,
  observation,
  showAgents = true,
  canAssign = false,
  compact = false,
}: {
  projectId: string;
  resourceId: string;
  pr: GitPullRequests['items'][number];
  observation?: { data?: GitChecks; isPending: boolean; isError: boolean };
  showAgents?: boolean;
  canAssign?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const statusLabels = {
    draft: t('gitPrStatusDraft'),
    checking: t('gitPrStatusChecking'),
    error: t('gitPrStatusError'),
    conflict: t('gitPrStatusConflict'),
    blocked: t('gitPrStatusBlocked'),
    ready: t('gitPrStatusReady'),
    unknown: t('gitPrStatusUnknown'),
  };
  const phaseLabels = {
    idle: t('gitPrAgentIdle'),
    working: t('gitPrAgentWorking'),
    watching: t('gitPrAgentWatching'),
    attention: t('gitPrAgentAttention'),
  };
  const query = useQuery({
    queryKey: ['workspace-git-checks', projectId, resourceId, pr.number],
    queryFn: ({ signal }) =>
      gitGet<GitChecks>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/pull-requests/${pr.number}/checks`,
        signal,
      ),
    refetchInterval: 60_000,
    enabled: observation === undefined,
    retry: false,
  });
  const checks = observation ?? query;
  const status = checks.isPending
    ? 'checking'
    : gitPrStatus(pr.head, pr.draft, checks.data, checks.isError);
  const Icon =
    status === 'checking'
      ? Loader2
      : status === 'ready'
        ? CircleCheck
        : status === 'error' || status === 'conflict'
          ? CircleX
          : CircleAlert;
  const color =
    status === 'error' || status === 'conflict'
      ? 'text-destructive'
      : status === 'ready'
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-muted-foreground';
  const tracking = pr.tracking;
  const agents = [...(tracking?.agents ?? [])];
  if (
    tracking?.creator &&
    !agents.some((a) => a.threadId === tracking.creator?.threadId)
  )
    agents.unshift({ ...tracking.creator, phase: 'idle', updatedAt: 0 });
  agents.sort(
    (a, b) =>
      Number(b.threadId === tracking?.creator?.threadId) -
      Number(a.threadId === tracking?.creator?.threadId),
  );
  return (
    <div
      className={
        compact
          ? 'flex min-w-0 flex-col gap-1'
          : 'flex flex-wrap items-center justify-between gap-x-2 gap-y-1'
      }
    >
      <div className={`flex items-center gap-1 ${color}`} role="status">
        <Icon
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 ${status === 'checking' ? 'animate-spin' : ''}`}
        />
        {statusLabels[status]}
      </div>
      {checks.isError && checks.data && (
        <p
          className={
            compact ? 'truncate text-muted-foreground' : 'text-muted-foreground'
          }
          title={t('gitPrStale', {
            date: new Date(checks.data.inspectedAt).toLocaleTimeString(),
          })}
        >
          {t('gitPrStale', {
            date: new Date(checks.data.inspectedAt).toLocaleTimeString(),
          })}
        </p>
      )}
      {showAgents && (
        <div
          className={
            compact
              ? 'flex min-w-0 items-center gap-3 overflow-x-auto'
              : 'flex min-w-0 flex-wrap gap-x-3 gap-y-1'
          }
        >
          {agents.length ? (
            agents.map((agent) => {
              const Activity =
                agent.phase === 'working'
                  ? Loader2
                  : agent.phase === 'watching'
                    ? Clock
                    : agent.phase === 'attention'
                      ? CircleAlert
                      : Pause;
              return (
                <Link
                  key={agent.threadId}
                  to="/t/$threadId"
                  params={{ threadId: agent.threadId }}
                  aria-label={`${agent.name} · ${phaseLabels[agent.phase]}`}
                  className={`inline-flex min-w-0 max-w-full items-center gap-1 text-primary underline underline-offset-2 ${compact ? 'shrink-0' : ''}`}
                  title={`${t(agent.threadId === tracking?.creator?.threadId ? 'gitPrCreator' : 'gitPrAssociated')} · ${phaseLabels[agent.phase]}`}
                >
                  <Bot aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{agent.name}</span>
                  <Activity
                    aria-label={phaseLabels[agent.phase]}
                    className={`h-3 w-3 shrink-0 ${agent.phase === 'working' ? 'animate-spin' : ''}`}
                  />
                </Link>
              );
            })
          ) : canAssign ? (
            <GitPrAgentPicker
              projectId={projectId}
              resourceId={resourceId}
              number={pr.number}
            />
          ) : (
            <span className="text-muted-foreground">{t('gitPrNoAgent')}</span>
          )}
        </div>
      )}
    </div>
  );
}
