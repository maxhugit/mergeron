import { PluginsService, localPluginState } from './plugins.service';
import type { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

const gmail = {
  id: 'gmail@openai-curated-remote',
  name: 'gmail',
  remotePluginId: 'plugin_connector_1p_gmail',
  source: { type: 'remote' },
  installed: true,
  enabled: true,
  localVersion: null,
  version: '0.1.10',
  installPolicy: 'AVAILABLE',
} as v2.PluginSummary;
const params = {
  remoteMarketplaceName: 'openai-curated-remote',
  pluginName: 'gmail',
};
const detail = (summary = gmail) => ({
  plugin: {
    summary,
    marketplaceName: params.remoteMarketplaceName,
    marketplacePath: null,
  },
});
function setup() {
  const request = vi.fn();
  return {
    request,
    service: new PluginsService({ request } as unknown as CodexService),
  };
}

describe('remote plugin installation', () => {
  it('resolves the backend ID instead of posting the catalog name, preserving the attempt ID', async () => {
    const { request, service } = setup();
    request
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce({ appsNeedingAuth: [] });
    await service.installPlugin({ ...params, installAttemptId: 'attempt-1' });
    expect(request.mock.calls).toEqual([
      ['plugin/read', params],
      [
        'plugin/install',
        {
          ...params,
          pluginName: gmail.remotePluginId,
          installAttemptId: 'attempt-1',
        },
      ],
    ]);
  });
  it.each([null, '', '   '])(
    'refuses to mutate when the canonical remote ID is missing (%s)',
    async (remotePluginId) => {
      const { request, service } = setup();
      request.mockResolvedValue(detail({ ...gmail, remotePluginId }));
      await expect(service.installPlugin(params)).rejects.toThrow(
        'remote plugin identifier is missing',
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('does not retry a failed installation using the short name', async () => {
    const { request, service } = setup();
    request
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new Error('upstream refused'));
    await expect(service.installPlugin(params)).rejects.toThrow(
      'upstream refused',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('passes local marketplace installations through unchanged', async () => {
    const { request, service } = setup();
    const local = {
      marketplacePath: '/plugins/marketplace.json',
      pluginName: 'gmail',
    };
    request.mockResolvedValue({});
    await service.installPlugin(local);
    expect(request).toHaveBeenCalledExactlyOnceWith('plugin/install', local);
  });
});

describe('local installation state', () => {
  it('does not equate installed on the account with installed on this server', () => {
    expect(localPluginState(gmail)).toMatchObject({
      installed: false,
      enabled: false,
    });
    expect(gmail.installed).toBe(true);
  });
  it('recognizes an actual local package even if the remote account flag is stale', () => {
    expect(
      localPluginState({ ...gmail, installed: false, localVersion: '0.1.10' })
        .installed,
    ).toBe(true);
  });
  it('preserves built-in and local marketplace plugins', () => {
    expect(
      localPluginState({ ...gmail, installPolicy: 'INSTALLED_BY_DEFAULT' })
        .installed,
    ).toBe(true);
    const local = {
      ...gmail,
      source: { type: 'local' },
    } as unknown as v2.PluginSummary;
    expect(localPluginState(local)).toBe(local);
  });
  it.each(['plugin/list', 'plugin/installed', 'plugin/read'])(
    'normalizes %s consistently',
    async (method) => {
      const { request, service } = setup();
      request.mockResolvedValue(
        method === 'plugin/read'
          ? detail()
          : {
              marketplaces: [{ name: 'remote', path: null, plugins: [gmail] }],
              marketplaceLoadErrors: [],
              featuredPluginIds: [],
            },
      );
      const result =
        method === 'plugin/read'
          ? await service.readPlugin(params)
          : method === 'plugin/list'
            ? await service.listPlugins()
            : await service.installedPlugins();
      const summary =
        'plugin' in result
          ? result.plugin.summary
          : result.marketplaces[0].plugins[0];
      expect(summary).toMatchObject({ installed: false, enabled: false });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
