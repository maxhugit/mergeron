import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { ManagerStatusService } from './manager-status.service';

class FixtureManagerStatusService extends ManagerStatusService {
  constructor(private readonly result: Record<string, unknown> | Error) {
    super(new ConfigService());
  }

  protected override requestManager(): Promise<Record<string, unknown>> {
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

describe('ManagerStatusService', () => {
  it('rejects the removed fast mode before contacting even an older Manager', async () => {
    const service = new FixtureManagerStatusService(
      new Error('must not be contacted'),
    );
    await expect(
      service.updateOperation('plan', { mode: 'dev-fast' }),
    ).rejects.toMatchObject({ status: 400, message: 'updateInvalidMode' });
  });
  it('uses fixed backup endpoints and discards arbitrary input fields', async () => {
    class BackupFixture extends ManagerStatusService {
      requests: unknown[][] = [];
      protected override requestManager(
        path?: string,
        method?: 'GET' | 'POST',
        payload?: Record<string, unknown>,
      ) {
        this.requests.push([path, method, payload]);
        return Promise.resolve({ backups: [] });
      }
    }
    const service = new BackupFixture(new ConfigService());
    await service.backups();
    await service.backupRetention();
    await service.setBackupRetention({ maxBackups: 10, path: '/outside' } as {
      maxBackups: number;
    });
    await service.deleteBackup({
      operationId: 'backup',
      confirmation: 'DELETE_UPDATE_BACKUP',
      path: '/home',
    } as { operationId: string; confirmation: string });
    expect(service.requests).toEqual([
      ['/v1/backups', undefined, undefined],
      ['/v1/backups/retention', undefined, undefined],
      ['/v1/backups/retention', 'POST', { maxBackups: 10 }],
      [
        '/v1/backups/delete',
        'POST',
        { operationId: 'backup', confirmation: 'DELETE_UPDATE_BACKUP' },
      ],
    ]);
  });
  it('forwards asynchronous update commands only to fixed local endpoints', async () => {
    class UpdateFixture extends ManagerStatusService {
      requests: unknown[][] = [];
      protected override requestManager(
        path?: string,
        method?: 'GET' | 'POST',
        payload?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        this.requests.push([path, method, payload]);
        return Promise.resolve({ busy: true });
      }
    }
    const service = new UpdateFixture(new ConfigService());
    for (const action of ['plan', 'apply', 'rollback', 'recover'] as const) {
      await service.updateOperation(action, {
        confirmation: 'explicit',
        images: { application: 'ghcr.io/maxhugit/mergeron:edge' },
        expectedFingerprint: 'fingerprint',
        operationId: 'operation',
      });
    }
    expect(service.requests.map(([path]) => path)).toEqual([
      '/v1/update/plan',
      '/v1/update',
      '/v1/update/rollback',
      '/v1/update/recover',
    ]);
    expect(service.requests.every(([, method]) => method === 'POST')).toBe(
      true,
    );
  });
  it('returns the manager inventory without modifying it', async () => {
    const service = new FixtureManagerStatusService({
      mode: 'observe',
      dockerConnected: true,
      components: [{ id: 'application', state: 'healthy' }],
      dataSafety: { status: 'protected' },
    });
    await expect(service.status()).resolves.toEqual({
      available: true,
      mode: 'observe',
      dockerConnected: true,
      components: [{ id: 'application', state: 'healthy' }],
      dataSafety: { status: 'protected' },
    });
  });

  it('reports an unavailable manager without claiming that the stack is healthy', async () => {
    const service = new FixtureManagerStatusService(new Error('offline'));
    await expect(service.status()).resolves.toMatchObject({
      available: false,
      mode: 'observe',
      dockerConnected: false,
      components: [],
      dataSafety: { status: 'unknown' },
      error: 'mergeronManagerUnavailable',
    });
  });

  it('forwards explicit adoption confirmation to the local manager', async () => {
    class AdoptionFixture extends ManagerStatusService {
      request: unknown[] | null = null;

      protected override requestManager(
        path?: string,
        method?: 'GET' | 'POST',
        payload?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        this.request = [path, method, payload];
        return Promise.resolve({ adoption: { state: 'adopted' } });
      }
    }
    const service = new AdoptionFixture(new ConfigService());
    await expect(
      service.adopt({
        confirmation: 'ADOPT_EXISTING_INSTALLATION',
        expectedFingerprint: 'fingerprint',
      }),
    ).resolves.toEqual({
      available: true,
      adoption: { state: 'adopted' },
    });
    expect(service.request).toEqual([
      '/v1/adoption',
      'POST',
      {
        confirmation: 'ADOPT_EXISTING_INSTALLATION',
        expectedFingerprint: 'fingerprint',
      },
    ]);
  });

  it('proxies installation preview and explicit application separately', async () => {
    class InstallationFixture extends ManagerStatusService {
      requests: unknown[][] = [];

      protected override requestManager(
        path?: string,
        method?: 'GET' | 'POST',
        payload?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        this.requests.push([path, method, payload]);
        return Promise.resolve({ applicable: true, actions: [] });
      }
    }
    const service = new InstallationFixture(new ConfigService());
    await service.installationPlan();
    await service.install({
      confirmation: 'INSTALL',
      expectedFingerprint: 'fingerprint',
    });
    expect(service.requests).toEqual([
      ['/v1/install/plan', undefined, undefined],
      [
        '/v1/install',
        'POST',
        { confirmation: 'INSTALL', expectedFingerprint: 'fingerprint' },
      ],
    ]);
  });
});
