import { IntegrationNav } from './integration-nav';
import {
  installedPlugins,
  installedPluginsKey,
} from '@/lib/integration-inventory';
/**
 * Plugins tab: marketplace browser with search, featured strip, install/uninstall.
 */
import { useMemo, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  appsListAppsQueryKey,
  mcpServersListServersQueryKey,
  pluginsListPluginsQueryKey,
  pluginsReadPluginQueryKey,
  pluginsInstallPluginMutation,
  pluginsReconcilePluginMutation,
  pluginsUninstallPluginMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { pluginsListPlugins } from '@/generated/api/sdk.gen';
import type {
  PluginMarketplaceEntryDto,
  PluginReconcileResponseDto,
  PluginSummaryDto,
} from '@/generated/api/types.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import { getApiErrorMessage } from '@/lib/api-error';
import { queryHasId } from '@/lib/query-invalidation';
import { pluginReference } from './plugin-reference';
import { PluginCard } from './plugin-card';
import { PluginDetailSheet, type PluginKey } from './plugin-detail-sheet';

export function PluginsTab({ catalogOnly = false }: { catalogOnly?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { t: ti } = useTranslation('integrations');
  const [view, setView] = useState<'installed' | 'featured' | 'catalog'>(
    catalogOnly ? 'catalog' : 'installed',
  );
  const [catalogPage, setCatalogPage] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedPlugin, setSelectedPlugin] = useState<PluginKey | null>(null);
  const [lastReconcile, setLastReconcile] =
    useState<PluginReconcileResponseDto | null>(null);

  // --- Data ---
  const queryKey =
    view === 'installed' ? installedPluginsKey : pluginsListPluginsQueryKey();
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey,
    enabled: !queryClient.getQueryState(queryKey)?.error,
    queryFn: async ({ signal }) => {
      if (view === 'installed') return installedPlugins(signal);
      const { data } = await pluginsListPlugins({
        signal,
        meta: { silent: true },
        throwOnError: true,
      });
      return data;
    },
    staleTime: 5 * 60_000,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });

  const marketplaces = useMemo(() => data?.marketplaces ?? [], [data]);
  const loadErrors = data?.marketplaceLoadErrors ?? [];
  const remoteSyncError = data?.remoteSyncError ?? null;
  const featuredIds = useMemo(
    () => new Set(data?.featuredPluginIds ?? []),
    [data],
  );

  // Flatten all plugins for search/featured
  const allPlugins = useMemo(() => {
    const result: Array<{
      plugin: PluginSummaryDto;
      marketplace: PluginMarketplaceEntryDto;
    }> = [];
    for (const mp of marketplaces) {
      for (const p of mp.plugins) result.push({ plugin: p, marketplace: mp });
    }
    return result;
  }, [marketplaces]);

  const featured = useMemo(
    () => allPlugins.filter(({ plugin }) => featuredIds.has(plugin.id)),
    [allPlugins, featuredIds],
  );
  const installed = useMemo(
    () =>
      allPlugins.filter(
        ({ plugin }) =>
          plugin.installed || plugin.installPolicy === 'INSTALLED_BY_DEFAULT',
      ),
    [allPlugins],
  );

  // --- Mutations ---
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: installedPluginsKey });
    void queryClient.invalidateQueries({
      queryKey: pluginsListPluginsQueryKey(),
    });
    void queryClient.invalidateQueries({
      predicate: (q) => queryHasId(q, 'pluginsReadPlugin'),
    });
    void queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() });
    void queryClient.invalidateQueries({
      predicate: (q) => queryHasId(q, 'skillsListSkills'),
    });
    void queryClient.invalidateQueries({
      queryKey: mcpServersListServersQueryKey(),
    });
  };

  const installMutation = useMutation({
    ...pluginsInstallPluginMutation(),
    onSuccess: (res) => {
      invalidateAll();
      const needsAuth = res.appsNeedingAuth?.length ?? 0;
      showSnackbar(
        needsAuth > 0
          ? t('pluginInstalledCountAppSNeedAuthentication', {
              count: needsAuth,
            })
          : t('pluginInstalled'),
        'success',
      );
    },
    onError: (err) => showSnackbar(getApiErrorMessage(err), 'error'),
  });

  const uninstallMutation = useMutation({
    ...pluginsUninstallPluginMutation(),
    onSuccess: () => {
      invalidateAll();
      showSnackbar(t('pluginUninstalled'), 'success');
    },
    onError: (err) => showSnackbar(getApiErrorMessage(err), 'error'),
  });

  const reconcileMutation = useMutation({
    ...pluginsReconcilePluginMutation(),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: installedPluginsKey });
      invalidateAfterReconcile(queryClient, res, allPlugins);
      setLastReconcile(res);
      const failures =
        res.failedRemotePluginIds.length +
        res.failedMaterializationRemotePluginIds.length;
      if (failures > 0) {
        showSnackbar(t('pluginSyncCompletedWithWarnings'), 'warning', 5000);
      } else if (res.changedPlugins.length > 0) {
        showSnackbar(
          t('pluginSyncCompletedCountChanged', {
            count: res.changedPlugins.length,
          }),
          'success',
        );
      } else {
        showSnackbar(t('pluginSyncCompletedNoChanges'), 'success');
      }
    },
    onError: (err) => showSnackbar(getApiErrorMessage(err), 'error'),
  });

  const mutating = installMutation.isPending || uninstallMutation.isPending;

  const makeCardProps = (
    plugin: PluginSummaryDto,
    mp: PluginMarketplaceEntryDto,
  ) => ({
    plugin,
    marketplacePath: mp.path,
    marketplaceName: mp.name,
    featured: featuredIds.has(plugin.id),
    disabled: mutating,
    onSelect: setSelectedPlugin,
    onInstall: () =>
      installMutation.mutate({
        body: pluginReference(mp, plugin.name),
      }),
    onUninstall: () =>
      uninstallMutation.mutate({ body: { pluginId: plugin.id } }),
  });

  const navigation = !catalogOnly && (
    <IntegrationNav
      label={ti('pluginViews')}
      value={view}
      onChange={(next) => {
        setView(next);
        setSearch('');
        setCatalogPage(0);
      }}
      secondary
      items={[
        { value: 'installed', label: ti('installedIntegrated') },
        { value: 'featured', label: ti('featured') },
        { value: 'catalog', label: ti('catalog') },
      ]}
    />
  );
  if (isLoading)
    return (
      <div>
        {navigation}
        <Skeleton className="h-20 w-full" />
      </div>
    );
  if (isError && !data)
    return (
      <div>
        {navigation}
        <ErrorBanner message={t('failedToLoadPlugins')} />
        <Button variant="ghost" onClick={() => void refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  const visiblePlugins =
    view === 'installed'
      ? installed
      : view === 'featured'
        ? featured
        : catalogOnly
          ? allPlugins
          : allPlugins.filter(({ plugin }) => !plugin.installed);
  const displayed = search.trim()
    ? visiblePlugins.filter(({ plugin }) =>
        (plugin.interface?.displayName ?? plugin.name)
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : visiblePlugins;
  const pageCount = Math.max(1, Math.ceil(displayed.length / 50));
  const currentPage = Math.min(catalogPage, pageCount - 1);
  const pagePlugins = displayed.slice(currentPage * 50, (currentPage + 1) * 50);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      {navigation}
      {/* Search + Refresh */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative min-w-0 basis-full sm:flex-1 sm:basis-0">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCatalogPage(0);
            }}
            placeholder={t('searchPlugins')}
            className="pl-9"
          />
          {search && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => {
                setSearch('');
                setCatalogPage(0);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('refresh')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={reconcileMutation.isPending}
          onClick={() => reconcileMutation.mutate({ body: { reason: 'user' } })}
        >
          {reconcileMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('syncInstalled')}
        </Button>
      </div>

      {isError && data && (
        <p role="status" className="text-xs text-muted-foreground">
          {ti('cachedInventory')}
        </p>
      )}
      {/* Error banners */}
      {remoteSyncError && (
        <ErrorBanner
          message={t('remoteSyncFailedMsg', { msg: remoteSyncError })}
        />
      )}
      {loadErrors.map((err) => (
        <ErrorBanner
          key={err.marketplacePath}
          message={`${err.marketplacePath}: ${err.message}`}
        />
      ))}
      {lastReconcile && <ReconcileWarnings result={lastReconcile} />}

      <div
        role="region"
        aria-label={ti('list')}
        tabIndex={0}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1"
      >
        {pagePlugins.map(({ plugin, marketplace }) => (
          <PluginCard
            key={`${marketplace.name}::${marketplace.path}::${plugin.id}`}
            {...makeCardProps(plugin, marketplace)}
          />
        ))}
        {displayed.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">
            {t('noPluginsAvailable')}
          </p>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex shrink-0 items-center justify-between gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setCatalogPage(currentPage - 1)}
          >
            {ti('previousPage')}
          </Button>
          <span role="status">
            {ti('catalogPage', {
              page: currentPage + 1,
              pages: pageCount,
              count: displayed.length,
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setCatalogPage(currentPage + 1)}
          >
            {ti('nextPage')}
          </Button>
        </div>
      )}
      <PluginDetailSheet
        pluginKey={selectedPlugin}
        onClose={() => setSelectedPlugin(null)}
        onInstall={(reference) =>
          installMutation.mutate({
            body: reference,
          })
        }
        onUninstall={(id) =>
          uninstallMutation.mutate({ body: { pluginId: id } })
        }
        mutating={mutating}
      />
    </div>
  );
}
function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function ReconcileWarnings({ result }: { result: PluginReconcileResponseDto }) {
  const { t } = useTranslation();
  if (
    result.failedRemotePluginIds.length === 0 &&
    result.failedMaterializationRemotePluginIds.length === 0
  ) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t('pluginSyncCompletedWithWarnings')}</span>
      </div>
      {result.failedRemotePluginIds.length > 0 && (
        <FailureList
          title={t('updateFailures')}
          ids={result.failedRemotePluginIds}
        />
      )}
      {result.failedMaterializationRemotePluginIds.length > 0 && (
        <FailureList
          title={t('bundleMaterializationFailures')}
          ids={result.failedMaterializationRemotePluginIds}
        />
      )}
    </div>
  );
}

function FailureList({ title, ids }: { title: string; ids: string[] }) {
  return (
    <div className="pl-5">
      <div className="font-medium">{title}</div>
      <div className="break-all text-muted-foreground">{ids.join(', ')}</div>
    </div>
  );
}

function invalidateAfterReconcile(
  queryClient: ReturnType<typeof useQueryClient>,
  result: PluginReconcileResponseDto,
  plugins: Array<{
    plugin: PluginSummaryDto;
    marketplace: PluginMarketplaceEntryDto;
  }>,
) {
  const changedIds = new Set(result.changedPlugins.map((plugin) => plugin.id));
  const failedIds = new Set([
    ...result.failedRemotePluginIds,
    ...result.failedMaterializationRemotePluginIds,
  ]);
  const pluginIds = new Set([...changedIds, ...failedIds]);
  if (pluginIds.size > 0) {
    void queryClient.invalidateQueries({ queryKey: installedPluginsKey });
    void queryClient.invalidateQueries({
      queryKey: pluginsListPluginsQueryKey(),
    });
  }

  for (const { plugin, marketplace } of plugins) {
    if (!pluginIds.has(plugin.id)) continue;
    void queryClient.invalidateQueries({
      queryKey: pluginsReadPluginQueryKey({
        query: pluginReference(marketplace, plugin.name),
      }),
    });
  }

  const changedPlugins = result.changedPlugins;
  if (changedPlugins.some((plugin) => plugin.hasApps)) {
    void queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() });
    void queryClient.invalidateQueries({
      predicate: (query) => queryHasId(query, 'appsReadApps'),
    });
  }
  if (changedPlugins.some((plugin) => plugin.hasMcps)) {
    void queryClient.invalidateQueries({
      queryKey: mcpServersListServersQueryKey(),
    });
  }
  if (changedPlugins.some((plugin) => plugin.hasSkills)) {
    void queryClient.invalidateQueries({
      predicate: (query) => queryHasId(query, 'skillsListSkills'),
    });
  }
}
