import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitMerge, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { checkTone, mergeCheckState } from '@/lib/git-check-status';
import {
  gitGet,
  type GitMerges,
  type GitMergeChecks,
} from '@/lib/workspace-git-api';

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
            <p role="status">
              <span
                className={`inline-block rounded px-2 py-1 font-medium ${checkTone(state)}`}
              >
                {states[state]}
              </span>
            </p>
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
