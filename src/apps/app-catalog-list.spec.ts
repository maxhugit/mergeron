import { catalogApp, validateDirectory } from './app-catalog-model';
import { AppsService } from './apps.service';
import type { CodexService } from '../codex/codex.service';
import type { AppCatalogService } from './app-catalog.service';
const snapshot = {
  scope: 'scope',
  updatedAt: 123,
  apps: [
    { id: 'a', name: 'A' },
    { id: 'hidden', name: 'Hidden', visibility: 'HIDDEN' },
    { id: 'b', name: 'B' },
  ],
};
it('serves local pages, uses live permissions and never invokes a directory download', async () => {
  const request = vi.fn().mockResolvedValue({
    apps: [{ id: 'a', enabled: true, callable: false, runtimeName: 'A' }],
  });
  const service = new AppsService(
    { request } as unknown as CodexService,
    { enabled: true, snapshot: () => snapshot } as unknown as AppCatalogService,
  );
  const first = await service.listApps({ limit: 1, forceRefetch: true });
  expect(first.data[0]).toMatchObject({
    id: 'a',
    isEnabled: true,
    isAccessible: false,
  });
  expect(first.nextCursor).toBeTruthy();
  const next = await service.listApps({ limit: 1, cursor: first.nextCursor });
  expect(next.data[0].id).toBe('b');
  expect(next.nextCursor).toBeNull();
  expect(
    request.mock.calls.every(([method]) => method === 'app/installed'),
  ).toBe(true);
  await expect(
    service.listApps({ cursor: 'catalog:other:123:1' }),
  ).rejects.toThrow('CATALOG_CURSOR_EXPIRED');
});
it('keeps native mode independent of the removable cache adapter', async () => {
  const request = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  const service = new AppsService(
    { request } as unknown as CodexService,
    { enabled: false } as AppCatalogService,
  );
  await service.listApps({ limit: 10 });
  expect(request).toHaveBeenCalledWith('app/list', { limit: 10 });
});
it('keeps discovery metadata readable when the runtime is offline without granting access', async () => {
  const request = vi.fn().mockRejectedValue(Error('offline'));
  const service = new AppsService(
    { request } as unknown as CodexService,
    { enabled: true, snapshot: () => snapshot } as unknown as AppCatalogService,
  );
  const result = await service.listApps();
  expect(result.data).toHaveLength(2);
  expect(result.data.every((app) => !app.isAccessible && !app.isEnabled)).toBe(
    true,
  );
  const detail = await service.readApps({
    appIds: ['a', 'unknown'],
    includeTools: true,
  });
  expect(detail.apps[0].toolSummaries).toBeNull();
  expect(detail.missingAppIds).toEqual(['unknown']);
});

it('uses the provider ID as the display name for an unnamed directory entry', () => {
  const raw = { id: 'unnamed', name: '' };
  expect(validateDirectory({ apps: [raw] })).toHaveLength(1);
  expect(catalogApp(raw).name).toBe('unnamed');
});
