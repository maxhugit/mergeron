import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { translationKey } from '@/locales/translation-key';
import {
  requestServerRelease,
  serverReleaseQueryKey,
  serverReleaseQueryOptions,
} from './server-release-api';
import { ManagerUpdateControls } from './manager-update-controls';
import { ManagerBackups } from './manager-backups';
import {
  managerStatusQueryKey,
  requestManagerStatus,
} from './manager-status-api';

export function ServerVersionCard({
  view = 'all',
}: {
  view?: 'all' | 'current' | 'update' | 'backups';
}) {
  const { t, i18n } = useTranslation();
  const { t: tm } = useTranslation('manager');
  const client = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const query = useQuery(serverReleaseQueryOptions);
  const manager = useQuery({
    queryKey: managerStatusQueryKey,
    queryFn: requestManagerStatus,
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: false,
  });
  const data = query.data;
  const error = refreshError ?? query.error?.message ?? data?.checkError;

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      client.setQueryData(
        serverReleaseQueryKey,
        await requestServerRelease(true),
      );
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };
  const refreshControl = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={refreshing || query.isLoading}
      onClick={() => void refresh()}
    >
      <RefreshCw
        aria-hidden="true"
        className={cn('h-4 w-4', refreshing && 'animate-spin')}
      />
      {tm('managerRefreshDetection')}
    </Button>
  );

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card/50 p-4">
      <div hidden={view !== 'all' && view !== 'current'} className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t('mergeronVersion')}</h2>
            <p className="text-xs text-muted-foreground">
              {tm('managerAutomaticDetection')}
            </p>
          </div>
        </div>

        {query.isLoading && (
          <p className="text-sm text-muted-foreground">
            {t('loadingb04ba49f')}
          </p>
        )}

        {data && (
          <>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-background/60 p-3">
                <dt className="text-xs text-muted-foreground">
                  {t('installedVersion')}
                </dt>
                <dd className="mt-1 font-medium">
                  {data.installed.version ?? t('unknown')}
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-background/60 p-3">
                <dt className="text-xs text-muted-foreground">
                  {t('releaseChannel')}
                </dt>
                <dd className="mt-1 font-medium">
                  {t(
                    data.installed.channel === 'stable'
                      ? 'stableChannel'
                      : data.installed.channel === 'edge'
                        ? 'edgeChannel'
                        : 'unknown',
                  )}
                </dd>
              </div>
              <div className="rounded-lg border border-border bg-background/60 p-3 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">
                  {tm('managerAvailableImage')}
                </dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 font-medium">
                  <span>{data.latestVersion ?? t('unknown')}</span>
                  {data.targetImage && (
                    <span className="break-all font-mono text-xs">
                      {data.targetImage}
                    </span>
                  )}
                  {data.latestRevision && (
                    <span className="font-mono text-xs">
                      {data.latestRevision.slice(0, 7)}
                    </span>
                  )}
                  {data.latestUrl && (
                    <a
                      href={data.latestUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      {t('openRelease')}
                      <ExternalLink
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                      />
                    </a>
                  )}
                </dd>
              </div>
            </dl>

            {!error &&
              data.latestVersion &&
              data.versionStatus !== 'unknown' && (
                <div
                  role="status"
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-3 text-sm',
                    data.versionStatus === 'update_available'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : data.versionStatus === 'current'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'border-border bg-background/60 text-muted-foreground',
                  )}
                >
                  {data.versionStatus === 'update_available' ? (
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                  ) : (
                    <CheckCircle2
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                  )}
                  <span>
                    {data.versionStatus === 'update_available'
                      ? tm('managerNewImageAvailable')
                      : t(
                          data.versionStatus === 'current'
                            ? 'mergeronIsUpToDate'
                            : data.versionStatus === 'edge'
                              ? 'thisServerFollowsEdgeAndMayContainUnpublishedChanges'
                              : 'installedVersionIsNewerThanLatestPublishedStableVersion',
                        )}
                  </span>
                </div>
              )}

            {data.installed.revision && (
              <p className="break-all text-xs text-muted-foreground">
                {t('buildRevision')}: {data.installed.revision}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('lastChecked')}:{' '}
              {new Date(data.checkedAt).toLocaleString(i18n.language)}
            </p>
          </>
        )}

      </div>
      {error && view !== 'backups' && (
        <p role="alert" className="text-sm text-destructive">
          {t(translationKey(error))}
        </p>
      )}

      <div hidden={view !== 'all' && view !== 'update'} className="space-y-4">
        {data?.updateAvailable && data.changesError && (
          <p role="status" className="text-sm text-muted-foreground">
            {tm('managerChangesUnavailable')}
          </p>
        )}
        {data?.changesTruncated && (
          <p className="text-sm text-muted-foreground">
            {tm('managerChangesTruncated')}
          </p>
        )}
        {data?.updateAvailable && data.releases.length > 0 && (
          <section className="space-y-3 border-t border-border pt-4">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">
                {t('availableImprovements')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {tm('managerImageChangesDescription')}
              </p>
            </div>
            {data.releases.map((release) => (
              <article
                key={release.version}
                className="space-y-3 rounded-lg border border-border bg-background/60 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">Mergeron {release.version}</h4>
                  {release.publishedAt && (
                    <time
                      dateTime={release.publishedAt}
                      className="text-xs text-muted-foreground"
                    >
                      {new Date(release.publishedAt).toLocaleDateString(
                        i18n.language,
                      )}
                    </time>
                  )}
                </div>
                {release.sections.map((section) => (
                  <div key={section.heading} className="space-y-1">
                    <h5 className="text-sm font-medium">{section.heading}</h5>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {section.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <a
                  href={release.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                >
                  {t('openTheFullReleaseNote')}
                  <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                </a>
              </article>
            ))}
          </section>
        )}
        {manager.data ? (
          <ManagerUpdateControls
            status={manager.data}
            trailingActions={refreshControl}
            showBackups={view === 'all'}
          />
        ) : (
          refreshControl
        )}
      </div>
      {view !== 'all' && (
        <div hidden={view !== 'backups'}>
          {manager.data ? (
            <ManagerBackups status={manager.data} />
          ) : (
            <p
              role={manager.isError ? 'alert' : 'status'}
              className="text-sm text-muted-foreground"
            >
              {tm(
                manager.isError
                  ? 'managerBackupsUnavailable'
                  : 'managerBackupsLoading',
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
