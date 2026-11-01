import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { translationKey } from '@/locales/translation-key';
import {
  requestServerRelease,
  serverReleaseQueryKey,
  serverReleaseQueryOptions,
} from './server-release-api';
import { ManagerUpdateControls } from './manager-update-controls';
import { ManagerBackups } from './manager-backups';
import { ManagerUpdateHistory } from './manager-update-history';
import { InstalledVersions } from './installed-versions';
import {
  componentUpdatesKey,
  requestComponentUpdates,
} from './manager-image-updates-api';
import {
  managerStatusQueryKey,
  requestManagerStatus,
} from './manager-status-api';

export function ServerVersionCard({
  view = 'all',
  actionsContainer,
}: {
  view?: 'all' | 'current' | 'update' | 'backups';
  actionsContainer?: HTMLElement | null;
}) {
  const { t } = useTranslation('manager');
  const client = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const release = useQuery(serverReleaseQueryOptions);
  const manager = useQuery({
    queryKey: managerStatusQueryKey,
    queryFn: requestManagerStatus,
    refetchInterval: 20000,
    staleTime: 10000,
    retry: false,
  });
  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [nextRelease, nextManager, nextUpdates] = await Promise.all([
        requestServerRelease(true),
        requestManagerStatus(),
        requestComponentUpdates(true),
      ]);
      client.setQueryData(serverReleaseQueryKey, nextRelease);
      client.setQueryData(managerStatusQueryKey, nextManager);
      client.setQueryData(componentUpdatesKey, nextUpdates);
    } catch {
      setError('componentUpdatesUnavailable');
    } finally {
      setRefreshing(false);
    }
  };
  const refreshControl = (
    <Button
      variant="outline"
      size="sm"
      disabled={refreshing}
      onClick={() => void refresh()}
    >
      {t('managerRefreshDetection')}
    </Button>
  );
  return (
    <section className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(translationKey(error))}
        </p>
      )}
      <div hidden={view !== 'all' && view !== 'current'}>
        {manager.data?.available && release.data ? (
          <ManagerUpdateControls
            status={manager.data}
            showBackups={false}
            actionsContainer={actionsContainer}
            renderUpdates={(controls) => (
              <InstalledVersions
                application={release.data.installed}
                status={manager.data}
                release={release.data}
                {...controls}
                trailingActions={refreshControl}
              />
            )}
          />
        ) : release.data ? (
          <InstalledVersions
            application={release.data.installed}
            status={manager.data}
            trailingActions={refreshControl}
          />
        ) : (
          <p role="status">{t('componentUpdatesLoading')}</p>
        )}
      </div>
      <div hidden={view !== 'update'}>
        {view === 'update' && manager.data && (
          <ManagerUpdateHistory status={manager.data} />
        )}
      </div>
      <div hidden={view !== 'backups'}>
        {view === 'backups' && manager.data ? (
          <ManagerBackups status={manager.data} />
        ) : (
          <p role={manager.isError ? 'alert' : 'status'}>
            {t(
              manager.isError
                ? 'managerBackupsUnavailable'
                : 'managerBackupsLoading',
            )}
          </p>
        )}
      </div>
    </section>
  );
}
