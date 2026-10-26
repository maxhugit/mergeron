import { ConfigService } from '@nestjs/config';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { projects, projectWorkspaces } from '../database/schema';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { WorkspaceTransfersService } from './workspace-transfers.service';
import { ProjectLocationsService } from './project-locations.service';
import { ProjectLocationTransfersController } from './project-location-transfers.controller';

describe('WorkspaceTransfersService', () => {
  let database: TestDatabase;
  let root: string;
  let source: string;
  let destination: string;
  let service: WorkspaceTransfersService;

  beforeEach(async () => {
    database = createTestDatabase();
    root = await mkdtemp(path.join(os.tmpdir(), 'workspace-transfers-'));
    source = path.join(root, 'source');
    destination = path.join(root, 'destination');
    await mkdir(path.join(source, '.git'), { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(source, 'new.txt'), 'new');
    await writeFile(path.join(source, 'conflict.txt'), 'source');
    await writeFile(path.join(source, '.git', 'config'), 'secret metadata');
    await writeFile(path.join(destination, 'conflict.txt'), 'destination');
    await writeFile(path.join(destination, 'orphan.txt'), 'orphan');
    const now = Date.now();
    database.db
      .insert(projects)
      .values({
        id: 'project',
        name: 'Project',
        workspacePath: source,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values([
        {
          id: 'source',
          projectId: 'project',
          name: 'Source',
          path: source,
          primary: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'destination',
          projectId: 'project',
          name: 'Destination',
          path: destination,
          primary: false,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    const resources = new WorkspaceResourcesService(
      database.db,
      new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'test-key' }),
    );
    service = new WorkspaceTransfersService(database.db, resources);
  });

  afterEach(async () => {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  });

  it('uses normalized locations, keeps preview read-only and requires a local writable destination', async () => {
    const inventory = new ProjectLocationsService(database.db);
    const controller = new ProjectLocationTransfersController(
      inventory,
      service,
    );
    expect(() =>
      controller.create('project', {
        sourceResourceId: 'source',
        destinationWorkspaceId: 'destination',
      }),
    ).toThrow();
    expect(() =>
      controller.create('project', {
        sourceLocationId: 'local:source',
        destinationLocationId: 'local:missing',
      }),
    ).toThrow();
    const { transfer } = controller.create('project', {
      name: 'Normalized',
      sourceLocationId: 'local:source',
      destinationLocationId: 'local:destination',
      conflictPolicy: 'skip',
    });
    expect(transfer).toMatchObject({
      sourceLocationId: 'local:source',
      destinationLocationId: 'local:destination',
    });
    expect(transfer).not.toHaveProperty('sourceResourceId');
    const preview = await controller.preview('project', transfer!.id);
    await expect(readFile(path.join(destination, 'new.txt'))).rejects.toThrow();
    database.sqlite
      .prepare(
        "UPDATE project_locations SET access_mode='read_only' WHERE id='local:destination'",
      )
      .run();
    await expect(
      controller.execute('project', transfer!.id, preview.id),
    ).rejects.toThrow();
    await expect(readFile(path.join(destination, 'new.txt'))).rejects.toThrow();
  });

  it('previews conflicts and copies without propagating deletions by default', async () => {
    const transfer = service.create('project', {
      name: 'Manual copy',
      sourceResourceId: 'source',
      destinationWorkspaceId: 'destination',
      conflictPolicy: 'skip',
    });
    const preview = await service.preview('project', transfer.id);

    expect(preview.summary).toMatchObject({
      create: 1,
      conflict: 1,
      delete: 0,
    });
    expect(preview.changes.some((item) => item.path.startsWith('.git'))).toBe(
      false,
    );
    const result = await service.execute('project', transfer.id, preview.id);
    expect(result.run.status).toBe('completed_with_conflicts');
    await expect(
      readFile(path.join(destination, 'new.txt'), 'utf8'),
    ).resolves.toBe('new');
    await expect(
      readFile(path.join(destination, 'conflict.txt'), 'utf8'),
    ).resolves.toBe('destination');
    await expect(
      readFile(path.join(destination, 'orphan.txt'), 'utf8'),
    ).resolves.toBe('orphan');
    await expect(
      service.execute('project', transfer.id, preview.id),
    ).resolves.toMatchObject({ idempotent: true });
  });

  it('overwrites and deletes only when configured, and safely retries', async () => {
    const transfer = service.create('project', {
      name: 'Mirror copy',
      sourceResourceId: 'source',
      destinationWorkspaceId: 'destination',
      conflictPolicy: 'overwrite',
      propagateDeletes: true,
    });
    const preview = await service.preview('project', transfer.id);
    await writeFile(path.join(destination, 'conflict.txt'), 'changed later');

    await expect(
      service.execute('project', transfer.id, preview.id),
    ).rejects.toThrow('changed after preview');
    await writeFile(path.join(destination, 'conflict.txt'), 'destination');
    const retried = await service.execute('project', transfer.id, preview.id);

    expect(retried.run.status).toBe('success');
    await expect(
      readFile(path.join(destination, 'conflict.txt'), 'utf8'),
    ).resolves.toBe('source');
    await expect(
      readFile(path.join(destination, 'orphan.txt')),
    ).rejects.toThrow();
  });

  it('validates project confinement and exclusion patterns', () => {
    expect(() =>
      service.create('project', {
        name: 'Escape',
        sourceResourceId: 'source',
        destinationWorkspaceId: 'destination',
        destinationPath: '../outside',
      }),
    ).toThrow('stay in its resource');
    expect(() =>
      service.create('project', {
        name: 'Bad exclusion',
        sourceResourceId: 'source',
        destinationWorkspaceId: 'destination',
        exclusions: ['../secret'],
      }),
    ).toThrow('Invalid exclusion');
  });
});
