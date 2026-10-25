import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogRetentionService } from './log-retention.service';
import { DEFAULT_LOG_RETENTION, LOG_RETENTION_KEY } from './log-retention';
import type { SettingsService } from '../settings/settings.service';

const io = vi.hoisted(() => ({
  prune: vi.fn().mockResolvedValue(undefined),
  inventory: vi.fn().mockResolvedValue([{ name: 'app.1.log', bytes: 25 }]),
}));
vi.mock('./log-retention', async (original) => ({
  ...(await original<typeof import('./log-retention')>()),
  pruneLogArchives: io.prune,
  logStorageInventory: io.inventory,
}));
function create() {
  const settings = {
    getSetting: vi.fn(() => ({ value: DEFAULT_LOG_RETENTION })),
    updateSetting: vi.fn(),
    onChange: vi.fn(() => () => {}),
  };
  return {
    settings,
    service: new LogRetentionService(settings as unknown as SettingsService),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('log retention administration', () => {
  it('never deletes files when reading storage or saving settings', async () => {
    const { settings, service } = create();
    expect(await service.storage()).toMatchObject({ estimatedBytes: 25 });
    service.update(DEFAULT_LOG_RETENTION);
    expect(settings.updateSetting).toHaveBeenCalledWith(
      LOG_RETENTION_KEY,
      DEFAULT_LOG_RETENTION,
    );
    expect(io.prune).not.toHaveBeenCalled();
  });
  it('rejects invalid settings without persisting them', () => {
    const { settings, service } = create();
    expect(() =>
      service.update({ application: { enabled: true, maxFiles: 0 } }),
    ).toThrow('Invalid');
    expect(settings.updateSetting).not.toHaveBeenCalled();
  });
  it('disables cleanup if stored settings are malformed', () => {
    const { settings, service } = create();
    settings.getSetting.mockReturnValue({ value: null as never });
    expect(service.policy().application.enabled).toBe(false);
    expect(service.policy().codex.enabled).toBe(false);
  });
  it('runs periodic cleanup and stops its timer on shutdown', async () => {
    vi.useFakeTimers();
    const { service } = create();
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(io.prune).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(io.prune).toHaveBeenCalledTimes(1);
  });
});
