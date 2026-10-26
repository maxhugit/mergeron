import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectConnectionsController } from './project-connections.controller';
import { accessContext } from '../auth/access-context';
import { IdentityService } from '../auth/identity.service';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectParticipants,
  projectWorkspaces,
} from '../database/schema';
import { ProjectLocationsService } from './project-locations.service';
import { ProjectLocationsController } from './project-locations.controller';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import type { FilesService } from '../files/files.service';
import type { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';

let database: TestDatabase;
let inventory: ProjectLocationsService;
let resources: WorkspaceResourcesService;
let identities: IdentityService;

beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(projects)
    .values([
      {
        id: 'p',
        name: 'Project',
        workspacePath: '/workspaces/p',
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 'other',
        name: 'Other',
        workspacePath: '/other',
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    .run();
  database.db
    .insert(projectWorkspaces)
    .values({
      id: 'local',
      projectId: 'p',
      name: 'Primary',
      path: '/workspaces/p',
      primary: true,
      createdAt: 1,
      updatedAt: 2,
    })
    .run();
  database.db
    .insert(people)
    .values({
      id: 'member',
      reference: 'M',
      name: 'Member',
      role: 'standard',
      active: true,
      createdAt: 1,
      updatedAt: 2,
    })
    .run();
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: 1 })
    .run();
  inventory = new ProjectLocationsService(database.db);
  resources = new WorkspaceResourcesService(
    database.db,
    new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'test-key' }),
  );
  identities = new IdentityService(database.db);
});
afterEach(() => database?.sqlite.close());

const asMember = <T>(action: () => T): T =>
  accessContext.run(
    {
      identity: {
        kind: 'person',
        personId: 'member',
        name: 'Member',
        role: 'standard',
        active: true,
      },
      identities,
    },
    action,
  );

it('exposes the normalized inventory to project participants without credentials or connection errors', () => {
  const resource = resources.create('p', {
    name: 'Files',
    type: 'sftp',
    address: 'sftp://host.example.test',
    rootPath: '/project',
    secret: { password: 'plaintext-test-secret' },
  });
  const view = asMember(() =>
    new ProjectLocationsController(
      inventory,
      new ActiveFoldersService(database.db),
      {} as FilesService,
      {} as WorkspaceCopiesService,
    ).list('p'),
  );
  expect(view.modelVersion).toBe(1);
  expect(view.connections).toEqual([
    expect.objectContaining({ id: resource.id, protocol: 'sftp' }),
  ]);
  expect(view.connections[0]).not.toHaveProperty('rootPath');
  expect(view.connections[0]).not.toHaveProperty('accessMode');
  expect(view.connections[0]).not.toHaveProperty('lastError');
  expect(view.locations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'local:local',
        kind: 'managed_local',
        connectionId: null,
      }),
      expect.objectContaining({
        id: `remote:${resource.id}`,
        kind: 'remote',
        path: '/project',
        connectionId: resource.id,
        accessMode: 'read_only',
      }),
    ]),
  );
  expect(JSON.stringify(view)).not.toMatch(
    /plaintext-test-secret|encryptedValue|authTag|password/,
  );
  expect(
    database.sqlite
      .prepare('SELECT count(*) AS n FROM project_workspace_secrets')
      .get(),
  ).toEqual({ n: 1 });
});

it('enforces project membership without adding any execution grant', () => {
  expect(() => asMember(() => inventory.list('other'))).toThrow();
  expect(() =>
    asMember(() =>
      resources.create('p', {
        name: 'No',
        type: 'git',
        address: 'https://example.test/no.git',
      }),
    ),
  ).toThrow();
  expect(() => inventory.list('missing')).toThrow('Project not found');
  expect(asMember(() => inventory.list('p')).connections).toEqual([]);
});

it('reflects legacy changes immediately without requiring an inventory read to backfill data', () => {
  const resource = resources.create('p', {
    name: 'Git',
    type: 'git',
    address: 'https://example.test/a.git',
  });
  resources.update('p', resource.id, { name: 'Updated', rootPath: '/new' });
  expect(inventory.list('p').locations).toContainEqual(
    expect.objectContaining({
      connectionId: resource.id,
      name: 'Updated',
      path: '/new',
    }),
  );
  resources.setEnabled('p', resource.id, false);
  expect(inventory.list('p').connections[0].enabled).toBe(false);
  resources.detach('p', resource.id);
  expect(inventory.list('p').connections).toEqual([]);
  expect(inventory.list('p').locations).toHaveLength(1);
});

it('scopes connection mutations and normalized ID resolution to their project', () => {
  const controller = new ProjectConnectionsController(
    inventory,
    resources,
    {} as WorkspaceCopiesService,
  );
  const created = controller.create('p', {
    name: 'Git',
    protocol: 'git',
    address: 'https://example.test/a.git',
  });
  expect(created.connection.protocol).toBe('git');
  expect(created.location.connectionId).toBe(created.connection.id);
  expect(() => controller.disable('other', created.connection.id)).toThrow(
    'Project connection not found',
  );
  expect(() => inventory.resourceId('other', created.location.id)).toThrow(
    'Project location not found',
  );
  expect(() => inventory.workspaceId('p', created.location.id)).toThrow(
    'local destination',
  );
  expect(() =>
    asMember(() => controller.disable('p', created.connection.id)),
  ).toThrow();
  expect(
    controller.disable('p', created.connection.id).connection.enabled,
  ).toBe(false);
  expect(controller.enable('p', created.connection.id).connection.enabled).toBe(
    true,
  );
});

it('never calls the filesystem for remote, unknown or escaping location selections', () => {
  const readDirectory = vi.fn();
  const controller = new ProjectLocationsController(
    inventory,
    new ActiveFoldersService(database.db),
    { readDirectory } as unknown as FilesService,
    {} as WorkspaceCopiesService,
  );
  const remote = resources.create('p', {
    name: 'Git',
    type: 'git',
    address: 'https://example.test/a.git',
  });
  for (const [id, relative] of [
    [`remote:${remote.id}`, ''],
    ['local:local', '../outside'],
    ['local:local', '/outside'],
    ['local:missing', ''],
  ]) {
    expect(() => controller.tree('p', id, relative)).toThrow();
  }
  expect(() => controller.tree('p', 'local:local', ['bad'])).toThrow(
    'relative directory',
  );
  expect(readDirectory).not.toHaveBeenCalled();
});
