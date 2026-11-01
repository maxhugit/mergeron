import { translationKey } from '@/locales/translation-key';
/** MCP aggregate status badge with server detail popover and reload action. */
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PlugZap,
  RefreshCw,
  CircleHelp,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  mcpServersListServers,
  mcpServersReloadAll,
} from '@/generated/api/sdk.gen';
import { mcpServersListServersQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import type { McpServerStartupState, McpServerStatus } from '@/types/mcp';
import { cn } from '@/lib/utils';
import { showSnackbar } from '@/stores/snackbar-store';
import { useMcpStore, type McpServerRuntimeStatus } from '@/stores/mcp-store';
import { useCurrentProject } from '@/hooks/use-current-project';

type Mode = 'input' | 'header';

interface McpRow {
  name: string;
  status: McpServerStartupState | 'unobserved';
  error: string | null;
  authStatus?: McpServerStatus['authStatus'];
  toolCount?: number;
}

interface Props {
  threadId?: string | null;
  mode?: Mode;
  menuItem?: boolean;
}

const STALE_STARTING_STATUS_MS = 30_000;

/** Header mode only appears for starting/failed; input mode always shows aggregate status. */
export function McpStatusBadge({
  threadId,
  mode = 'input',
  menuItem = false,
}: Props) {
  const { t } = useTranslation(['common', 'codexSettings'], {
    nsMode: 'fallback',
  });
  const queryClient = useQueryClient();
  const runtimeStatuses = useMcpStore((s) => s.statuses);
  const project = useCurrentProject();
  const allowedNames = project ? new Set(project.mcpServerIds ?? []) : null;
  if (threadId && allowedNames) allowedNames.add('mergeron_internal');
  // The controller already supports threadId. Keep it in both the request and
  // cache identity; global startup notifications carry no conversation identity.
  const query = {
    detail: 'toolsAndAuthOnly' as const,
    ...(threadId ? { threadId } : {}),
  };
  const hasStartingRuntime = Object.values(runtimeStatuses).some(
    (server) => server.status === 'starting',
  );

  const serversQuery = useQuery({
    queryKey: mcpServersListServersQueryKey({ query }),
    queryFn: async () => {
      const { data } = await mcpServersListServers({
        query,
        throwOnError: true,
      });
      return data;
    },
    staleTime: 30_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchInterval: threadId || hasStartingRuntime ? 5_000 : false,
  });

  const reloadMutation = useMutation({
    mutationFn: () => mcpServersReloadAll({ throwOnError: true }),
    onSuccess: () => {
      showSnackbar(t('mcpServersReloading'), 'success');
      void queryClient.invalidateQueries({
        queryKey: mcpServersListServersQueryKey(),
      });
    },
  });

  const rows = buildRows(
    ((serversQuery.data?.data ?? []) as unknown as McpServerStatus[]).filter(
      (server) => !allowedNames || allowedNames.has(server.name),
    ),
    threadId
      ? {}
      : allowedNames
        ? Object.fromEntries(
            Object.entries(runtimeStatuses).filter(([name]) =>
              allowedNames.has(name),
            ),
          )
        : runtimeStatuses,
    serversQuery.isSuccess,
  );
  if (
    threadId &&
    project &&
    !rows.some((row) => row.name === 'mergeron_internal')
  ) {
    rows.unshift({
      name: 'mergeron_internal',
      status: 'unobserved',
      error: null,
    });
  }
  if (serversQuery.isError) {
    for (const row of rows) {
      row.status = 'unobserved';
      row.toolCount = undefined;
    }
  }
  const failed = rows.filter((row) => row.status === 'failed').length;
  const starting = rows.filter((row) => row.status === 'starting').length;
  const ready = rows.filter((row) => row.status === 'ready').length;
  const total = rows.length;

  if (mode === 'header') {
    if (failed === 0 && starting === 0) return null;
    return (
      <Badge
        variant={failed > 0 ? 'destructive' : 'secondary'}
        className="text-xs"
      >
        {failed > 0 ? (
          <AlertCircle className="h-3 w-3" />
        ) : (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {failed > 0 ? t('mcpCountFailed', { count: failed }) : t('mcpStarting')}
      </Badge>
    );
  }

  if (serversQuery.isLoading && total === 0) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 rounded-lg px-2 text-xs"
        disabled
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('mcp')}
      </Button>
    );
  }

  const label = serversQuery.isError
    ? t('failedToLoadMcpServers')
    : total > 0
      ? t('readyTotalReady', { ready, total })
      : t('noMcpServersReported');
  const risky = failed > 0 || serversQuery.isError;
  const busy = starting > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 gap-1 rounded-lg px-2 text-xs',
            menuItem && 'w-full justify-start',
            risky && 'text-destructive',
          )}
          title={t('mcpServers8d9a304f')}
        >
          {risky ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlugZap className="h-3.5 w-3.5" />
          )}
          <span className={menuItem ? 'inline' : 'hidden sm:inline'}>
            {menuItem ? `${t('mcpServers')} · ${label}` : label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 space-y-3 p-3 text-sm"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              {t('mcpServers')}
            </div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={
              reloadMutation.isPending ||
              !rows.some((row) => row.name !== 'mergeron_internal')
            }
            onClick={() => reloadMutation.mutate()}
          >
            {reloadMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('reloadAll')}
          </Button>
        </div>

        {serversQuery.isError && (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {t('failedToLoadMcpServers')}
          </p>
        )}

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {rows.map((row) => (
            <ServerRow key={row.name} row={row} />
          ))}
          {rows.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('noMcpServersReported')}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ServerRow({ row }: { row: McpRow }) {
  const { t } = useTranslation(['common', 'codexSettings'], {
    nsMode: 'fallback',
  });
  const Icon =
    row.status === 'unobserved'
      ? CircleHelp
      : row.status === 'failed'
        ? AlertCircle
        : row.status === 'starting'
          ? Loader2
          : CheckCircle2;

  return (
    <div className="rounded-md border border-border/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            row.status === 'failed' && 'text-destructive',
            row.status === 'ready' && 'text-green-500',
            row.status === 'starting' && 'animate-spin text-blue-500',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {row.name === 'mergeron_internal'
            ? t('mcpInternalMergeron')
            : row.name}
        </span>
        <Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'}>
          {row.status === 'unobserved'
            ? t('mcpNotObserved')
            : t(translationKey(row.status))}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-5 text-[11px] text-muted-foreground">
        {row.authStatus && (
          <span>
            {t('auth')}: {t(translationKey(row.authStatus))}
          </span>
        )}
        {row.toolCount !== undefined && (
          <span>
            {t('tools0284c6ac')}: {row.toolCount}
          </span>
        )}
      </div>
      {row.error && (
        <p className="mt-1 pl-5 text-xs text-destructive">{row.error}</p>
      )}
      {row.status === 'unobserved' && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('mcpInternalNotObservedHint')}
        </p>
      )}
    </div>
  );
}

function buildRows(
  servers: McpServerStatus[],
  runtimeStatuses: Record<string, McpServerRuntimeStatus>,
  inventoryLoaded: boolean,
): McpRow[] {
  const rows = new Map<string, McpRow>();
  const now = Date.now();
  const isStaleStarting = (runtime?: McpServerRuntimeStatus) =>
    inventoryLoaded &&
    runtime?.status === 'starting' &&
    now - runtime.updatedAt > STALE_STARTING_STATUS_MS;
  for (const server of servers) {
    const runtime = runtimeStatuses[server.name];
    rows.set(server.name, {
      name: server.name,
      status: isStaleStarting(runtime) ? 'ready' : (runtime?.status ?? 'ready'),
      error: isStaleStarting(runtime) ? null : (runtime?.error ?? null),
      authStatus: server.authStatus,
      toolCount: Object.keys(server.tools ?? {}).length,
    });
  }
  for (const runtime of Object.values(runtimeStatuses)) {
    if (isStaleStarting(runtime)) continue;
    if (!rows.has(runtime.name)) {
      rows.set(runtime.name, {
        name: runtime.name,
        status: runtime.status,
        error: runtime.error,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
