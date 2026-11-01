import { PluginsTab } from './plugins-tab';
import { IntegrationNav } from './integration-nav';
import {
  installedApps,
  installedAppsKey,
  runtimeAppInfo,
} from '@/lib/integration-inventory';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { appsListApps } from '@/generated/api/sdk.gen';
/**
 * Apps tab: paginated list with enable/disable toggle and external install links.
 */
import { useRef, useState } from 'react';
import { ExternalLink, Loader2, Power, SlidersHorizontal } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  appsListAppsQueryKey,
  codexConfigReadConfigOptions,
  codexStatusGetStatusOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import { codexConfigUpdateConfig } from '@/generated/api/sdk.gen';
import type { AppInfoDto } from '@/generated/api/types.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import { getApiErrorMessage } from '@/lib/api-error';
import { queryHasId } from '@/lib/query-invalidation';
import { AppDefaultsSheet } from './app-defaults-sheet';
import { AppDetailSheet } from './app-detail-sheet';

export function AppsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { t: ti } = useTranslation('integrations');
  const [view, setView] = useState<'connected' | 'catalog'>('connected');
  const refreshRuntime = useRef(false);
  const [association, setAssociation] = useState<AppInfoDto | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [selectedApp, setSelectedApp] = useState<AppInfoDto | null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);

  const queryKey =
    view === 'connected'
      ? installedAppsKey
      : appsListAppsQueryKey({ query: { cursor: cursor ?? undefined } });
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey,
    // Revisiting a failed category must not start another directory request.
    // An explicit refetch still works while automatic fetching is disabled.
    enabled: !queryClient.getQueryState(queryKey)?.error,
    queryFn: async ({ signal }) => {
      if (view === 'connected') {
        const forceRefresh = refreshRuntime.current;
        refreshRuntime.current = false;
        const response = await installedApps(signal, forceRefresh);
        return { data: response.apps.map(runtimeAppInfo), nextCursor: null };
      }
      const { data } = await appsListApps({
        query: { cursor: cursor ?? undefined },
        signal,
        throwOnError: true,
        meta: { silent: true },
      });
      return data;
    },
    staleTime: 5 * 60_000,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });

  const apps = data?.data ?? [];
  const nextCursor = data?.nextCursor ?? null;

  const invalidateAppsConfig = () => {
    void queryClient.invalidateQueries({ queryKey: installedAppsKey });
    void queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() });
    void queryClient.invalidateQueries({
      queryKey: codexConfigReadConfigOptions().queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: codexStatusGetStatusOptions().queryKey,
    });
    void queryClient.invalidateQueries({
      predicate: (query) => queryHasId(query, 'appsReadApps'),
    });
  };

  const goNext = () => {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack, cursor]);
    setCursor(nextCursor);
  };
  const goPrevious = () => {
    setCursorStack((stack) => {
      const next = stack.slice(0, -1);
      setCursor(stack.at(-1) ?? null);
      return next;
    });
  };

  const navigation = (
    <IntegrationNav
      label={ti('applicationViews')}
      value={view}
      onChange={(next) => {
        setView(next);
        setCursor(null);
        setCursorStack([]);
      }}
      secondary
      items={[
        { value: 'connected', label: ti('connected') },
        { value: 'catalog', label: ti('catalog') },
      ]}
    />
  );
  if (isLoading)
    return (
      <div>
        {navigation}
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (isError && !data)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        {navigation}
        <div role="alert" className="shrink-0 rounded-lg border p-4 text-sm">
          <p>
            {ti(
              view === 'catalog' ? 'directoryFallback' : 'inventoryUnavailable',
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                refreshRuntime.current = view === 'connected';
                void refetch();
              }}
            >
              {ti('retry')}
            </Button>
            {view === 'catalog' && (
              <Button asChild variant="outline">
                <a
                  href="https://chatgpt.com/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {ti('openOfficialDirectory')}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            )}
          </div>
        </div>
        {view === 'catalog' && <PluginsTab catalogOnly />}
      </div>
    );

  // App defaults are configured independently of the list, so the entry point
  // and its sheet stay mounted even when no apps are available.
  const isEmpty = apps.length === 0 && cursorStack.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {navigation}
      {isError && (
        <p role="status" className="text-xs text-muted-foreground">
          {ti('cachedInventory')}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={isFetching}
          onClick={() => {
            refreshRuntime.current = view === 'connected';
            void refetch();
          }}
        >
          {ti(view === 'connected' ? 'refreshConnections' : 'refresh')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setDefaultsOpen(true)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('defaults')}
        </Button>
      </div>

      {isEmpty ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t('noAppsAvailable')}
        </p>
      ) : (
        <div
          role="region"
          aria-label={ti('list')}
          tabIndex={0}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1"
        >
          {apps.map((app) => (
            <AppRow
              key={app.id}
              app={app}
              onToggled={invalidateAppsConfig}
              onOpenDetails={() => setSelectedApp(app)}
              onAssociate={() => setAssociation(app)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {(cursorStack.length > 0 || nextCursor) && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={isFetching || cursorStack.length === 0}
            onClick={goPrevious}
          >
            {t('previous')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isFetching || !nextCursor}
            onClick={goNext}
          >
            {t('next')}
          </Button>
        </div>
      )}

      <Dialog
        open={association !== null}
        onOpenChange={(open) => !open && setAssociation(null)}
      >
        <DialogContent className="bg-popover!">
          <DialogHeader>
            <DialogTitle>
              {ti('associateApplication', { name: association?.name })}
            </DialogTitle>
            <DialogDescription>
              {ti('associationDescription')}
            </DialogDescription>
          </DialogHeader>
          {association?.installUrl &&
          /^https?:\/\//i.test(association.installUrl) ? (
            <Button asChild>
              <a
                href={association.installUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {ti('continueProvider')}
                <ExternalLink className="size-4" />
              </a>
            </Button>
          ) : (
            <p>{ti('associationUnavailable')}</p>
          )}
        </DialogContent>
      </Dialog>
      <AppDetailSheet app={selectedApp} onClose={() => setSelectedApp(null)} />
      <AppDefaultsSheet
        open={defaultsOpen}
        onClose={() => setDefaultsOpen(false)}
      />
    </div>
  );
}

/** Single app row with logo, toggle, and install link. */
function AppRow({
  app,
  onToggled,
  onOpenDetails,
  onAssociate,
}: {
  app: AppInfoDto;
  onToggled: () => void;
  onOpenDetails: () => void;
  onAssociate: () => void;
}) {
  const { t } = useTranslation();
  const { t: ti } = useTranslation('integrations');
  const [toggling, setToggling] = useState(false);

  const developer =
    app.branding?.developer ?? app.appMetadata?.developer ?? null;
  const category = app.branding?.category ?? null;

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await codexConfigUpdateConfig({
        body: {
          edits: [{ keyPath: `apps.${app.id}.enabled`, value: enabled }],
        },
        throwOnError: true,
      });
      showSnackbar(enabled ? t('appEnabled') : t('appDisabled'), 'success');
      onToggled();
    } catch (err) {
      showSnackbar(getApiErrorMessage(err), 'error');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
      {/* Logo or placeholder */}
      {app.logoUrl ? (
        <img
          src={app.logoUrl}
          alt={app.name}
          className="h-10 w-10 shrink-0 rounded-lg object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Power className="h-5 w-5 text-muted-foreground" />
        </div>
      )}

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{app.name}</span>
          {!app.isAccessible && (
            <Badge
              variant="outline"
              className="text-[10px] text-muted-foreground"
            >
              {t('notAvailable')}
            </Badge>
          )}
          {category && (
            <Badge variant="outline" className="text-[10px]">
              {category}
            </Badge>
          )}
        </div>
        {app.description && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {app.description}
          </p>
        )}
        {developer && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {developer}
          </p>
        )}
        {app.pluginDisplayNames.length > 0 && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {t('via')} {app.pluginDisplayNames.join(', ')}
          </p>
        )}
      </div>

      {/* Install link */}
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-xs"
        onClick={onOpenDetails}
      >
        <SlidersHorizontal className="h-3 w-3" />
        {t('manage')}
      </Button>

      {app.installUrl && (
        <Button size="sm" variant="ghost" onClick={onAssociate}>
          {ti('associate')}
        </Button>
      )}

      {/* Enable/Disable toggle */}
      <div className="flex items-center gap-2">
        {toggling && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
        <Switch
          checked={app.isEnabled}
          disabled={toggling || !app.isAccessible}
          onCheckedChange={handleToggle}
        />
      </div>
    </div>
  );
}
