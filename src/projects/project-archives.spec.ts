import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { access } from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../database/database.service';
import type { ThreadMetadataService } from '../threads/thread-metadata.service';
import type { IdentityRequest } from '../auth/platform-access.guard';
import {
  archiveAdministrator,
  ProjectArchivesController,
} from './project-archives.controller';
import { ProjectArchivesService } from './project-archives.service';

const services: ProjectArchivesService[] = [];
const migrated = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./project-workspace-layout', () => ({
  ProjectWorkspaceLayout: class {
    migrate = migrated;
  },
}));
const metadata = { invalidate: vi.fn() };

function service() {
  const instance = new ProjectArchivesService(
    { databasePath: '/tmp/archive-unit.sqlite' } as DatabaseService,
    new ConfigService(),
    metadata as unknown as ThreadMetadataService,
  );
  services.push(instance);
  const run = vi.spyOn(
    instance as unknown as {
      engine: (
        input: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    },
    'engine',
  );
  return { instance, run };
}

afterEach(async () => {
  await Promise.all(
    services.splice(0).map((instance) => instance.onModuleDestroy()),
  );
  vi.restoreAllMocks();
  metadata.invalidate.mockClear();
});

describe('project archive authorization', () => {
  it.each([
    undefined,
    { active: true, role: 'standard' },
    { active: false, role: 'administrator' },
  ])(
    'rejects non-active administrators before accessing data: %j',
    (identity) => {
      expect(() =>
        archiveAdministrator({ platformIdentity: identity } as IdentityRequest),
      ).toThrow('réservée aux administrateurs');
    },
  );

  it('binds upload ownership to the authenticated person', () => {
    expect(
      archiveAdministrator({
        platformIdentity: {
          active: true,
          role: 'administrator',
          personId: 'person',
        },
      } as IdentityRequest),
    ).toEqual({ personId: 'person', owner: 'person' });
  });

  it('denies export before invoking the archive service', async () => {
    const archives = { exportProject: vi.fn() };
    const controller = new ProjectArchivesController(
      archives as unknown as ProjectArchivesService,
    );
    await expect(
      controller.export(
        'project',
        {
          platformIdentity: { active: true, role: 'standard' },
        } as IdentityRequest,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(archives.exportProject).not.toHaveBeenCalled();
  });
});

describe('staged ZIP imports', () => {
  it('never accepts a preview token belonging to another person', async () => {
    const { instance, run } = service();
    run.mockResolvedValue({ compatible: true });
    const preview = await instance.preview('alice', Readable.from('zip'));
    await expect(
      instance.importProject('bob', 'bob', { token: preview.token }),
    ).rejects.toThrow('autre session');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('revalidates on confirmation, consumes the token and removes the staged ZIP', async () => {
    const { instance, run } = service();
    run
      .mockResolvedValueOnce({ compatible: true })
      .mockResolvedValueOnce({ projectId: 'new-project' });
    const preview = await instance.preview('alice', Readable.from('zip'));
    const file = run.mock.calls[0][0].archive as string;
    expect(
      await instance.importProject('alice', 'person', {
        token: preview.token,
        name: 'Copy',
        selection: ['files'],
        personMappings: { source: 'person' },
      }),
    ).toEqual({ projectId: 'new-project' });
    expect(run.mock.calls[1][0]).toMatchObject({
      action: 'import',
      personId: 'person',
      name: 'Copy',
      selection: ['files'],
      personMappings: { source: 'person' },
    });
    await expect(access(file)).rejects.toThrow();
    await expect(
      instance.importProject('alice', 'person', { token: preview.token }),
    ).rejects.toThrow('expiré');
    expect(metadata.invalidate).toHaveBeenCalledOnce();
    expect(migrated).toHaveBeenCalledWith('new-project');
  });

  it('removes temporary data after an incompatible ZIP', async () => {
    const { instance, run } = service();
    run.mockRejectedValueOnce(new Error('Incompatible format'));
    await expect(
      instance.preview('alice', Readable.from('zip')),
    ).rejects.toThrow('Incompatible');
    await expect(
      access(run.mock.calls[0][0].archive as string),
    ).rejects.toThrow();
  });

  it('does not import a truncated upload', async () => {
    const { instance, run } = service();
    const stream = Object.assign(Readable.from('zip'), { truncated: true });
    await expect(instance.preview('alice', stream)).rejects.toThrow('96 Mio');
    expect(run).not.toHaveBeenCalled();
  });

  it('allows only the owner to discard a preview', async () => {
    const { instance, run } = service();
    run.mockResolvedValue({ compatible: true });
    const preview = await instance.preview('alice', Readable.from('zip'));
    await expect(instance.discard('bob', preview.token)).rejects.toThrow();
    await instance.discard('alice', preview.token);
    await expect(
      instance.importProject('alice', 'person', { token: preview.token }),
    ).rejects.toThrow('expiré');
  });
});
