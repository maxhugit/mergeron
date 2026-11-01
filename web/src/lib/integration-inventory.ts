/** Inventory calls use the configured API client (auth, prefix and cancellation). */
import { client } from '@/generated/api/client.gen';
import type {
  AppInfoDto,
  PluginListResponseDto,
} from '@/generated/api/types.gen';

export interface InstalledApp {
  id: string;
  runtimeName: string | null;
  enabled: boolean;
  callable: boolean;
}
export const installedPluginsKey = [
  'integrations',
  'installed-plugins',
] as const;
export const installedAppsKey = ['integrations', 'installed-apps'] as const;
export async function installedPlugins(signal?: AbortSignal) {
  const { data } = await client.get<
    { 200: PluginListResponseDto },
    unknown,
    true
  >({
    url: '/api/plugins/installed',
    signal,
    throwOnError: true,
    ...{ meta: { silent: true } },
  });
  return data;
}
export async function installedApps(signal?: AbortSignal, refresh = false) {
  const { data } = await client.get<
    { 200: { apps: InstalledApp[] } },
    unknown,
    true
  >({
    url: '/api/apps/installed',
    query: refresh ? { forceRefresh: true } : undefined,
    signal,
    throwOnError: true,
    ...{ meta: { silent: true } },
  });
  return data;
}

/** Runtime names are best-effort; canonical metadata is read only in the modal. */
export function runtimeAppInfo(app: InstalledApp): AppInfoDto {
  return {
    id: app.id,
    name: app.runtimeName ?? app.id,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: app.callable,
    isEnabled: app.enabled,
    pluginDisplayNames: [],
  };
}
