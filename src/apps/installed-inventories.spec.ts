import { AppsService } from './apps.service';
import { PluginsService } from '../plugins/plugins.service';
import type { CodexService } from '../codex/codex.service';

describe('installed integration inventories', () => {
  it('never queries the app directory or refreshes the runtime implicitly', async () => {
    const result = {
      apps: [
        {
          id: 'home',
          runtimeName: 'Home Assistant',
          enabled: true,
          callable: true,
        },
      ],
    };
    const request = vi.fn().mockResolvedValue(result);
    const service = new AppsService({ request } as unknown as CodexService);
    expect(await service.installedApps()).toBe(result);
    expect(request).toHaveBeenCalledExactlyOnceWith('app/installed', {});
  });
  it('never queries the remote plugin catalog to list installed bundles', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ marketplaces: [], marketplaceLoadErrors: [] });
    const service = new PluginsService({ request } as unknown as CodexService);
    expect(await service.installedPlugins()).toEqual({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('plugin/installed', {});
  });
  it('does not silently substitute a directory fetch on an unsupported CLI', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Method not found'));
    await expect(
      new AppsService({ request } as unknown as CodexService).installedApps(),
    ).rejects.toThrow('Method not found');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
