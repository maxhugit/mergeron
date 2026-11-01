import {
  installedApps,
  installedAppsKey,
  runtimeAppInfo,
} from './integration-inventory';
import { mcpServersListServersQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import { mcpServersListServers } from '@/generated/api';
import type { AppInfoDto } from '@/generated/api/types.gen';

const INTEGRATIONS_STALE_TIME = 5 * 60_000;
const INTEGRATIONS_GC_TIME = 30 * 60_000;

/** Shared inventory queries let the project page warm the cache before the tab opens. */
export function projectMcpServersQueryOptions() {
  return {
    queryKey: mcpServersListServersQueryKey(),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const { data } = await mcpServersListServers({
        signal,
        meta: { silent: true },
        query: { detail: 'toolsAndAuthOnly' },
        throwOnError: true,
      });
      return data;
    },
    staleTime: INTEGRATIONS_STALE_TIME,
    gcTime: INTEGRATIONS_GC_TIME,
    refetchOnWindowFocus: false,
  } as const;
}

export function projectAppsQueryOptions() {
  return {
    queryKey: [...installedAppsKey, 'project'],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const result = await installedApps(signal);
      return result.apps.map(runtimeAppInfo);
    },
    retry: false,
    staleTime: INTEGRATIONS_STALE_TIME,
    gcTime: INTEGRATIONS_GC_TIME,
    refetchOnWindowFocus: false,
  } as const;
}

export function availableProjectApps(apps: readonly AppInfoDto[]) {
  return apps.filter((app) => app.isAccessible && app.isEnabled);
}
