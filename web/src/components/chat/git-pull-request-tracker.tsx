import { useState } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileText, GitPullRequest } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  gitGet,
  type GitChecks,
  type GitPullRequests,
} from '@/lib/workspace-git-api';
import { gitPrStatus } from '@/lib/git-pr-status';
import { GitPrTrackerSummary } from './git-pr-tracker-summary';
import { GitMergeAction } from './workspace-git-actions';

interface Props {
  projectId: string;
  resourceId: string;
  canWrite: boolean;
  resourceAddress: string | null;
  onCloseFocus: () => void;
}

/** Compact master/detail layout: selecting a PR never expands its list row. */
export function GitPullRequestTracker({
  projectId,
  resourceId,
  canWrite,
  resourceAddress,
  onCloseFocus,
}: Props) {
  const { t } = useTranslation('workspaces');
  const queryClient = useQueryClient();
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [lastMerged, setLastMerged] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const prs = useQuery({
    queryKey: ['workspace-git-prs', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<GitPullRequests>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/pull-requests`,
        signal,
      ),
    refetchInterval: 15_000,
    retry: false,
  });
  const pageCount = Math.max(1, Math.ceil((prs.data?.items.length ?? 0) / 5));
  const currentPage = Math.min(page, pageCount - 1);
  const rows =
    prs.data?.items.slice(currentPage * 5, (currentPage + 1) * 5) ?? [];
  const observations = useQueries({
    queries: rows.map((pr) => ({
      queryKey: ['workspace-git-checks', projectId, resourceId, pr.number],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        gitGet<GitChecks>(
          projectId,
          `resources/${encodeURIComponent(resourceId)}/pull-requests/${pr.number}/checks`,
          signal,
        ),
      enabled: !prs.isError,
      refetchInterval: 60_000,
      retry: false,
    })),
  });
  const selectedIndex = Math.max(
    0,
    rows.findIndex((pr) => pr.number === selectedNumber),
  );
  const selected = rows[selectedIndex];
  const observation = observations[selectedIndex];
  const checks = observation?.data;
  const failures = rows.filter((pr, i) =>
    ['error', 'conflict'].includes(
      gitPrStatus(
        pr.head,
        pr.draft,
        observations[i]?.data,
        observations[i]?.isError,
      ),
    ),
  ).length;
  const activeAgents = new Set(
    rows.flatMap((pr) =>
      (pr.tracking?.agents ?? [])
        .filter((a) => a.phase === 'working' || a.phase === 'watching')
        .map((a) => a.threadId),
    ),
  ).size;
  const checkLabels: Record<string, string> = {
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
  if (prs.isPending)
    return (
      <p role="status" className="p-3 text-xs">
        {t('gitLoading')}
      </p>
    );
  if (prs.isError)
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {t('gitGithubError')}
      </p>
    );
  if (!prs.data?.supported)
    return <p className="p-3 text-xs">{t('gitProviderUnsupported')}</p>;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden text-xs"
      aria-label={t('gitPrTracker')}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
          {t('gitPrOpenCount', { count: prs.data.items.length })}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {t('gitPrPageSummary', { failures, agents: activeAgents })}
        </span>
      </div>
      {prs.data.limited && (
        <p className="shrink-0 px-3 pb-1 text-muted-foreground">
          {t('gitLimited')}
        </p>
      )}
      {lastMerged !== null && (
        <p role="status" className="shrink-0 px-3 pb-1">
          #{lastMerged} · {t('gitActionMerged')}
        </p>
      )}
      {pageCount > 1 && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t('gitPrPrevious')}
          </Button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            {t('gitPrNext')}
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="p-3">{t('gitNoPr')}</p>
      ) : (
        <>
          <div
            role="region"
            className="max-h-64 shrink-0 space-y-1 overflow-y-auto px-2 pb-2"
            aria-label={t('gitPrList')}
          >
            {rows.map((pr, i) => (
              <article
                key={pr.number}
                className={`rounded-lg p-2 ${selected?.number === pr.number ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}`}
              >
                <button
                  type="button"
                  className="mb-1 block w-full cursor-pointer break-words text-left font-medium"
                  aria-label={`#${pr.number} ${pr.title}`}
                  aria-pressed={selected?.number === pr.number}
                  onClick={() => setSelectedNumber(pr.number)}
                >
                  <span className="mr-1 text-muted-foreground">
                    #{pr.number}
                  </span>
                  {pr.title}
                </button>
                <GitPrTrackerSummary
                  projectId={projectId}
                  resourceId={resourceId}
                  pr={pr}
                  observation={observations[i]}
                />
              </article>
            ))}
          </div>
          {selected && (
            <section
              aria-label={t('gitPrDetail', { number: selected.number })}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto border-t p-3"
            >
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground">
                  #{selected.number}
                </p>
                <h3 className="break-words font-medium">{selected.title}</h3>
                <p className="break-all text-[10px] text-muted-foreground">
                  {selected.branch} → {selected.base}
                </p>
              </div>
              <GitPrTrackerSummary
                projectId={projectId}
                resourceId={resourceId}
                pr={selected}
                observation={observation}
                showAgents={false}
              />
              {observation?.isPending ? (
                <p role="status">{t('gitLoading')}</p>
              ) : observation?.isError ? (
                <p role="alert" className="text-destructive">
                  {t('gitGithubError')}
                </p>
              ) : (
                checks && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-medium">{t('gitPrChecks')}</h4>
                      <span className="text-muted-foreground">
                        {t('gitPrChecksCount', {
                          passed: checks.items.filter(
                            (c) => c.status === 'success',
                          ).length,
                          total: checks.items.length,
                        })}
                      </span>
                    </div>
                    <div className="divide-y">
                      {checks.items.map((check) => (
                        <div
                          key={check.id}
                          className="flex items-start justify-between gap-3 py-1.5"
                        >
                          <span className="min-w-0 break-words">
                            {check.name}
                          </span>
                          <span
                            className={`shrink-0 ${check.status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : ['failure', 'error', 'timed_out', 'action_required', 'cancelled'].includes(check.status) ? 'text-destructive' : 'text-muted-foreground'}`}
                          >
                            {checkLabels[check.status] ?? t('gitCheckUnknown')}
                          </span>
                        </div>
                      ))}
                    </div>
                    {checks.items.length === 0 && (
                      <p className="text-muted-foreground">
                        {t('gitNoChecks')}
                      </p>
                    )}
                    {checks.limited && <p>{t('gitLimited')}</p>}
                    <p className="text-muted-foreground">
                      {t(
                        checks.mergeable === null
                          ? 'gitMergeUnknown'
                          : checks.mergeable
                            ? 'gitMergeNoConflict'
                            : 'gitMergeConflict',
                      )}
                    </p>
                  </>
                )
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="text-xs" asChild>
                  <a
                    href={`${selected.url}/checks`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {t('gitPrChecksDetails')}
                  </a>
                </Button>
                <Button variant="outline" size="sm" className="text-xs" asChild>
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('gitPrViewGithub')}
                  </a>
                </Button>
              </div>
              {checks &&
                checks.head === selected.head &&
                !observation?.isError &&
                canWrite && (
                  <GitMergeAction
                    key={selected.number}
                    projectId={projectId}
                    resourceId={resourceId}
                    number={selected.number}
                    checks={checks}
                    address={resourceAddress}
                    onMerged={() => {
                      setLastMerged(selected.number);
                      void queryClient.invalidateQueries({
                        queryKey: ['workspace-git-prs', projectId, resourceId],
                      });
                    }}
                    onCloseFocus={onCloseFocus}
                  />
                )}
              {checks?.inspectedAt && (
                <p className="text-[10px] text-muted-foreground">
                  {t('gitPrLastChecked', {
                    date: new Date(checks.inspectedAt).toLocaleTimeString(),
                  })}
                </p>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
