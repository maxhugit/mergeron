import { AppCatalogController } from './app-catalog.controller';
import { accessContext } from '../auth/access-context';
import { ForbiddenException } from '@nestjs/common';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { SettingsService } from '../settings/settings.service';
import type { AppCatalogTransport } from './app-catalog-transport.service';
import { AppCatalogService } from './app-catalog.service';
import { CATALOG_DAY } from './app-catalog-model';

describe('daily app directory snapshot', () => {
  let home: string,
    source: string,
    transport: { request: ReturnType<typeof vi.fn> };
  let service: AppCatalogService;
  const account = (id = 'account-a') =>
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'secret-test-access',
          account_id: id,
          id_token:
            'x.' +
            Buffer.from(JSON.stringify({ sub: 'user-a' })).toString(
              'base64url',
            ) +
            '.x',
        },
      }),
    );
  const create = () =>
    new AppCatalogService(
      { get: () => home } as unknown as ConfigService,
      {
        getSetting: () => ({ value: source }),
        updateSetting: (_k: string, v: string) => {
          source = v;
        },
      } as unknown as SettingsService,
      transport as unknown as AppCatalogTransport,
    );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    home = mkdtempSync(join(tmpdir(), 'mergeron-catalog-'));
    account();
    source = 'byparr';
    transport = {
      request: vi
        .fn()
        .mockResolvedValue({ apps: [{ id: 'one', name: 'One' }] }),
    };
    service = create();
  });
  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });
  it('downloads once per day, deduplicates concurrent jobs and survives restarts', async () => {
    await Promise.all([service.tick(), service.tick()]);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(service.snapshot().apps).toHaveLength(1);
    expect(create().status().count).toBe(1);
    await create().tick();
    expect(transport.request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CATALOG_DAY);
    await service.tick();
    expect(transport.request).toHaveBeenCalledTimes(2);
    const file = join(
      home,
      'webui',
      'app-directory',
      readdirSync(join(home, 'webui', 'app-directory'))[0],
    );
    expect(readFileSync(file, 'utf8')).not.toMatch(
      /secret-test-access|account-a|user-a/,
    );
  });
  it('retains the last valid file and journals a sanitized failure without a retry loop', async () => {
    await service.tick();
    const updated = service.status().updatedAt;
    transport.request.mockRejectedValue(
      Error('<html>secret-test-access</html>'),
    );
    vi.advanceTimersByTime(CATALOG_DAY);
    await service.tick();
    expect(service.status()).toMatchObject({
      warning: true,
      count: 1,
      updatedAt: updated,
    });
    expect(service.status().history[0]).toMatchObject({
      status: 'failed',
      code: 'CATALOG_DOWNLOAD_FAILED',
    });
    expect(JSON.stringify(service.status())).not.toContain(
      'secret-test-access',
    );
    await create().tick();
    expect(transport.request).toHaveBeenCalledTimes(2);
  });
  it('never overwrites a good catalog with invalid JSON shapes or duplicate entries', async () => {
    await service.tick();
    transport.request.mockResolvedValue({
      apps: [
        { id: 'bad', name: 'Bad' },
        { id: 'bad', name: 'Bad' },
      ],
    });
    vi.advanceTimersByTime(CATALOG_DAY);
    await service.tick();
    expect(service.snapshot().apps[0].id).toBe('one');
    expect(service.status().history[0].code).toBe('CATALOG_INVALID_RESPONSE');
  });
  it('never serves one account’s snapshot after an account change', async () => {
    await service.tick();
    account('account-b');
    expect(service.status().count).toBe(0);
    expect(() => service.snapshot()).toThrow('CATALOG_NOT_READY');
    await service.tick();
    expect(transport.request).toHaveBeenCalledTimes(2);
  });
  it('disables the scheduled workaround without deleting the last snapshot', async () => {
    await service.tick();
    await service.setSource('native');
    vi.advanceTimersByTime(CATALOG_DAY);
    await service.tick();
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(service.snapshot().apps).toHaveLength(1);
    expect(service.status().source).toBe('native');
  });
  it('records setup failures in the settings journal', async () => {
    source = 'native';
    transport.request.mockRejectedValue(Error('Docker private detail'));
    await expect(service.setSource('byparr')).rejects.toThrow(
      'CATALOG_PREPARE_FAILED',
    );
    expect(service.status()).toMatchObject({ source: 'native', warning: true });
    expect(service.status().history[0].code).toBe('CATALOG_PREPARE_FAILED');
  });
  it('records an interrupted attempt after restart while retaining the last good snapshot', async () => {
    await service.tick();
    const directory = join(home, 'webui', 'app-directory'),
      file = join(directory, readdirSync(directory)[0]);
    const state = JSON.parse(
      readFileSync(file, 'utf8'),
    ) as import('./app-catalog-model').CatalogState;
    state.history[0] = {
      at: Date.now(),
      status: 'running',
      code: 'CATALOG_RUNNING',
    };
    writeFileSync(file, JSON.stringify(state));
    const restarted = create();
    await restarted.tick();
    expect(restarted.status().history[0]).toMatchObject({
      status: 'failed',
      code: 'CATALOG_INTERRUPTED',
    });
    expect(restarted.snapshot().apps).toHaveLength(1);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it('clearly journals a missing Codex account without sending credentials to the Manager', async () => {
    rmSync(join(home, 'auth.json'));
    await service.tick();
    expect(service.status().history[0]).toMatchObject({
      status: 'failed',
      code: 'CATALOG_AUTH_UNAVAILABLE',
    });
    expect(transport.request).not.toHaveBeenCalled();
  });
  it('refreshes managed OAuth before the daily download instead of reusing yesterday’s access token', async () => {
    const request = vi.fn().mockImplementation(() => {
      const path = join(home, 'auth.json');
      const auth = JSON.parse(readFileSync(path, 'utf8')) as {
        tokens: { access_token: string };
      };
      auth.tokens.access_token = 'renewed-access-token';
      writeFileSync(path, JSON.stringify(auth));
      return Promise.resolve({ account: { type: 'chatgpt' } });
    });
    const refreshed = new AppCatalogService(
      { get: () => home } as unknown as ConfigService,
      { getSetting: () => ({ value: source }) } as unknown as SettingsService,
      transport as unknown as AppCatalogTransport,
      { request } as unknown as import('../codex/codex.service').CodexService,
    );
    await refreshed.tick();
    expect(request).toHaveBeenCalledWith('account/read', {
      refreshToken: true,
    });
    expect(transport.request).toHaveBeenCalledWith(
      'download',
      expect.objectContaining({ accessToken: 'renewed-access-token' }),
    );
  });
});

it('catalog status is restricted to administrators', async () => {
  const status = vi.fn();
  const catalog = { status, setSource: vi.fn() };
  const controller = new AppCatalogController(
    catalog as unknown as AppCatalogService,
  );
  const access = {
    identity: {},
    identities: {
      requireAdministrator() {
        throw new ForbiddenException();
      },
    },
  };
  await accessContext.run(
    access as never,
    async () =>
      await expect(controller.status()).rejects.toThrow(ForbiddenException),
  );
  expect(status).not.toHaveBeenCalled();
});
