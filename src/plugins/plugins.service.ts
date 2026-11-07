/** Plugins facade over Codex app-server JSON-RPC methods. */
import { BadRequestException, Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class PluginsService {
  constructor(private readonly codex: CodexService) {}

  /** Lists plugin marketplaces and installation state. */
  async listPlugins(
    params: v2.PluginListParams = {},
  ): Promise<v2.PluginListResponse> {
    const result = await this.codex.request<v2.PluginListResponse>(
      'plugin/list',
      params,
    );
    return normalizeMarketplacePlugins(result);
  }

  /** Lists local installed bundles without querying a remote marketplace. */
  async installedPlugins(): Promise<v2.PluginListResponse> {
    const result = await this.codex.request<v2.PluginInstalledResponse>(
      'plugin/installed',
      {},
    );
    return normalizeMarketplacePlugins({ ...result, featuredPluginIds: [] });
  }

  /** Reads detailed metadata for one plugin inside one marketplace. */
  async readPlugin(
    params: v2.PluginReadParams,
  ): Promise<v2.PluginReadResponse> {
    const result = await this.codex.request<v2.PluginReadResponse>(
      'plugin/read',
      params,
    );
    return {
      ...result,
      plugin: {
        ...result.plugin,
        summary: localPluginState(result.plugin.summary),
      },
    };
  }

  /** Installs a plugin through the app-server plugin lifecycle. */
  async installPlugin(
    params: v2.PluginInstallParams,
  ): Promise<v2.PluginInstallResponse> {
    if (params.remoteMarketplaceName) {
      // For remote installs the native field pluginName expects the backend ID,
      // while plugin/read accepts the catalog name used by our UI. Never send
      // that display/catalog name to the mutation endpoint.
      const { plugin } = await this.readPlugin({
        remoteMarketplaceName: params.remoteMarketplaceName,
        pluginName: params.pluginName,
      });
      const remotePluginId = plugin.summary.remotePluginId?.trim();
      if (!remotePluginId) {
        throw new BadRequestException(
          'The remote plugin identifier is missing. Refresh the plugin catalog before retrying.',
        );
      }
      params = { ...params, pluginName: remotePluginId };
    }
    return this.codex.request<v2.PluginInstallResponse>(
      'plugin/install',
      params,
    );
  }

  /** Reconciles installed plugin bundles against the latest plugin-service state. */
  reconcilePlugin(
    params: v2.PluginReconcileParams = {},
  ): Promise<v2.PluginReconcileResponse> {
    return this.codex.request<v2.PluginReconcileResponse>(
      'plugin/reconcile',
      params,
    );
  }

  /** Uninstalls a user-installed plugin. */
  uninstallPlugin(
    params: v2.PluginUninstallParams,
  ): Promise<v2.PluginUninstallResponse> {
    return this.codex.request<v2.PluginUninstallResponse>(
      'plugin/uninstall',
      params,
    );
  }
}

/** Account installation alone is not evidence of a bundle on this server. */
export function localPluginState(plugin: v2.PluginSummary): v2.PluginSummary {
  if (plugin.source.type !== 'remote') return plugin;
  const installed =
    plugin.installPolicy === 'INSTALLED_BY_DEFAULT' ||
    Boolean(plugin.localVersion?.trim());
  return { ...plugin, installed, enabled: installed && plugin.enabled };
}

function normalizeMarketplacePlugins<
  T extends { marketplaces: v2.PluginMarketplaceEntry[] },
>(result: T): T {
  return {
    ...result,
    marketplaces: result.marketplaces.map((marketplace) => ({
      ...marketplace,
      plugins: marketplace.plugins.map(localPluginState),
    })),
  };
}
