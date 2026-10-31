import { useQuery } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  ExternalLink,
  GitMerge,
  Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  checkTone,
  mergeCheckState,
  type MergeCheckState,
} from '@/lib/git-check-status';
import {
  gitGet,
  type GitMerges,
  type GitMergeChecks,
} from '@/lib/workspace-git-api';

const stateIcons = {
  passed: CircleCheck,
  failed: CircleX,
  running: Loader2,
  waiting: Clock3,
  unknown: CircleHelp,
  none: CircleHelp,
};

/** State is expressed by shape and text as well as semantic colour. */
export function GitMergeIndicator({
  state,
  label,
}: {
  state: MergeCheckState;
  label: string;
}) {
  const Icon = stateIcons[state];
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex min-w-0 items-center gap-3 py-1"
      data-merge-state={state}
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${checkTone(state)}`}
      >
        <Icon
          className={`h-7 w-7 ${state === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`}
          aria-hidden="true"
        />
      </span>
      <span className="min-w-0 break-words text-sm font-semibold">{label}</span>
    </div>
  );
}

export function GitMerges({
  projectId,
  resourceId,
}: {
  projectId: string;
  resourceId: string;
}) {
  const { t, i18n } = useTranslation('workspaces');
  const query = useQuery({
    queryKey: ['workspace-git-merges', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<GitMerges>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/merges`,
        signal,
      ),
    refetchInterval: 60000,
    retry: false,
  });
  return (
    <section
      aria-label={t('gitTabMerges')}
      data-git-merges
      className="min-w-0 space-y-3 p-3 text-xs"
    >
      <p className="text-muted-foreground">{t('gitMergesHelp')}</p>
      {query.isPending ? (
        <p role="status">{t('gitLoading')}</p>
      ) : query.isError ? (
        <div role="alert">
          <p className="text-destructive">{t('gitGithubError')}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void query.refetch()}
          >
            {t('gitRetry')}
          </Button>
        </div>
      ) : !query.data.supported ? (
        <p>{t('gitProviderUnsupported')}</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {t('gitRemoteObserved', {
              date: new Date(query.data.inspectedAt).toLocaleString(
                i18n.language,
              ),
            })}
          </p>
          {query.data.items.length === 0 && <p>{t('gitNoMerges')}</p>}
          {query.data.items.map((merge, index) => (
            <MergedPullRequest
              key={merge.number}
              projectId={projectId}
              resourceId={resourceId}
              merge={merge}
              expanded={index === 0}
            />
          ))}
          {query.data.limited && <p>{t('gitMergesLimited')}</p>}
        </>
      )}
    </section>
  );
}

function MergedPullRequest({
  projectId,
  resourceId,
  merge,
  expanded,
}: {
  projectId: string;
  resourceId: string;
  merge: GitMerges['items'][number];
  expanded: boolean;
}) {
  const { t, i18n } = useTranslation('workspaces');
  const query = useQuery({
    queryKey: ['workspace-git-merges', projectId, resourceId, merge.number],
    queryFn: ({ signal }) =>
      gitGet<GitMergeChecks>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/merges/${merge.number}/checks`,
        signal,
      ),
    refetchInterval: 30000,
    staleTime: 15000,
    retry: false,
  });
  const states = {
    passed: t('gitMergeChecksPassed'),
    failed: t('gitMergeChecksFailed'),
    running: t('gitCheckInProgress'),
    waiting: t('gitCheckWaiting'),
    unknown: t('gitCheckUnknown'),
    none: t('gitNoChecks'),
  };
  const statusLabels: Record<string, string> = {
    success: t('gitCheckSuccess'),
    failure: t('gitCheckFailure'),
    error: t('gitCheckError'),
    pending: t('gitCheckPending'),
    queued: t('gitCheckQueued'),
    in_progress: t('gitCheckInProgress'),
    waiting: t('gitCheckWaiting'),
    requested: t('gitCheckRequested'),
    neutral: t('gitCheckNeutral'),
    skipped: t('gitCheckSkipped'),
    cancelled: t('gitCheckCancelled'),
    timed_out: t('gitCheckTimedOut'),
    action_required: t('gitCheckActionRequired'),
    stale: t('gitCheckStale'),
  };
  const state = query.data ? mergeCheckState(query.data) : 'unknown';
  return (
    <article className="min-w-0 space-y-2 rounded-md border p-3">
      <h3 className="flex items-start gap-2 font-medium">
        <GitMerge
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400"
          aria-hidden="true"
        />
        <a
          href={merge.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 break-words hover:underline"
        >
          #{merge.number} {merge.title}
        </a>
      </h3>
      <p className="break-all text-muted-foreground">
        {merge.branch} → {merge.base}
      </p>
      <p className="text-muted-foreground">
        {t('gitMergedOn', {
          date: new Date(merge.mergedAt).toLocaleString(i18n.language),
        })}
      </p>
      {query.isPending ? (
        <p role="status" className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('gitLoading')}
        </p>
      ) : query.isError ? (
        <div role="alert">
          <p className="text-destructive">{t('gitMergeChecksError')}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void query.refetch()}
          >
            {t('gitRetry')}
          </Button>
        </div>
      ) : (
        query.data && (
          <>
            <GitMergeIndicator state={state} label={states[state]} />
            {query.data.workflows && (
              <WorkflowRuns workflows={query.data.workflows} />
            )}
            <p className="break-all font-mono text-muted-foreground">
              {t('gitMergeCommit', { sha: query.data.head.slice(0, 7) })}
            </p>
            {query.data.items.length > 0 && (
              <details open={expanded} className="min-w-0">
                <summary className="cursor-pointer py-1 font-medium">
                  {t('gitMergeJobs', { count: query.data.items.length })}
                </summary>
                <ul className="mt-2 space-y-2">
                  {query.data.items.map((check) => (
                    <li
                      key={check.id}
                      className="flex min-w-0 items-start justify-between gap-2"
                    >
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                        {check.name}
                      </span>
                      <span
                        className={`max-w-[45%] shrink-0 rounded px-1.5 py-0.5 text-[10px] ${checkTone(check.status)}`}
                      >
                        {statusLabels[check.status] ?? t('gitCheckUnknown')}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {query.data.limited && <p>{t('gitLimited')}</p>}
            <a
              href={query.data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline"
            >
              {t('gitMergeOpenChecks')}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
            <p className="text-muted-foreground">
              {t('gitRemoteObserved', {
                date: new Date(query.data.inspectedAt).toLocaleTimeString(
                  i18n.language,
                ),
              })}
            </p>
          </>
        )
      )}
    </article>
  );
}

function WorkflowRuns({
  workflows,
}: {
  workflows: NonNullable<GitMergeChecks['workflows']>;
}) {
  const { t } = useTranslation('workspaces');
  const statusLabel = (status: string) => {
    const key: Record<string, string> = {
      pending: 'gitCheckPending',
      queued: 'gitCheckQueued',
      waiting: 'gitCheckWaiting',
      requested: 'gitCheckRequested',
      in_progress: 'gitCheckInProgress',
      success: 'gitCheckSuccess',
      failure: 'gitCheckFailure',
      error: 'gitCheckError',
      cancelled: 'gitCheckCancelled',
      timed_out: 'gitCheckTimedOut',
      action_required: 'gitCheckActionRequired',
      skipped: 'gitCheckSkipped',
      neutral: 'gitCheckNeutral',
      stale: 'gitCheckStale',
    };
    return t(key[status] ?? 'gitCheckUnknown');
  };
  return (
    <div className="min-w-0 space-y-2">
      {!workflows.available && (
        <p className="text-muted-foreground">{t('gitWorkflowUnavailable')}</p>
      )}
      {workflows.items.length > 0 && (
        <h4 className="font-medium">{t('gitWorkflows')}</h4>
      )}
      <ul className="min-w-0 space-y-3">
        {workflows.items.map((run) => (
          <li key={run.id} className="min-w-0 space-y-1 rounded border p-2">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <a
                href={run.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 break-words text-primary underline [overflow-wrap:anywhere]"
              >
                {run.name || t('gitWorkflowRun', { id: run.id })}
              </a>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 ${checkTone(run.status)}`}
              >
                {statusLabel(run.status)}
              </span>
            </div>
            {run.waitReason === 'concurrency' && (
              <p className="break-words text-muted-foreground [overflow-wrap:anywhere]">
                {t('gitWorkflowConcurrency', {
                  groups: run.groups?.join(', '),
                })}
              </p>
            )}
            {run.blockers?.length ? (
              <>
                <p className="font-medium">{t('gitWorkflowBlockedBy')}</p>
                <ul className="min-w-0 space-y-1">
                  {run.blockers.map((blocker) => (
                    <li key={blocker.id} className="min-w-0">
                      <a
                        href={blocker.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-words text-primary underline [overflow-wrap:anywhere]"
                      >
                        {blocker.pullRequest
                          ? t('gitWorkflowBlockerPr', {
                              number: blocker.pullRequest,
                            })
                          : t('gitWorkflowRun', { id: blocker.id })}
                        {' · '}
                        {blocker.name}
                        {blocker.jobName ? ` · ${blocker.jobName}` : ''}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              run.waitReason && (
                <p className="text-muted-foreground">
                  {t('gitWorkflowWaitUnknown')}
                </p>
              )
            )}
            {run.queueLimited && (
              <p className="text-muted-foreground">
                {t('gitWorkflowQueueLimited')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {workflows.limited && (
        <p className="text-muted-foreground">{t('gitWorkflowLimited')}</p>
      )}
    </div>
  );
}
