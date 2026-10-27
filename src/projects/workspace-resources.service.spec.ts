import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { accessContext } from '../auth/access-context';
import { IdentityService } from '../auth/identity.service';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projectParticipants,
  projects,
  projectWorkspaceSecrets,
  projectWorkspaces,
} from '../database/schema';
import { WorkspaceResourcesService } from './workspace-resources.service';

let database: TestDatabase;
let service: WorkspaceResourcesService;
let identities: IdentityService;

beforeEach(() => {
  database = createTestDatabase();
  const now = Date.now();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Project',
      workspacePath: '/workspaces/p',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectWorkspaces)
    .values({
      id: 'local',
      projectId: 'p',
      name: 'Principal',
      path: '/workspaces/p',
      primary: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(people)
    .values({
      id: 'member',
      reference: 'MEM',
      name: 'Member',
      firstName: 'Member',
      lastName: 'Test',
      role: 'standard',
      active: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: now })
    .run();
  identities = new IdentityService(database.db);
  service = new WorkspaceResourcesService(
    database.db,
    new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'test-encryption-key' }),
  );
});

afterEach(() => database.sqlite.close());

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
const asAdmin = <T>(action: () => T): T =>
  accessContext.run(
    {
      identity: {
        kind: 'service',
        personId: null,
        name: 'Administrator',
        role: 'administrator',
        active: true,
      },
      identities,
    },
    action,
  );

it('backfills local workspaces as compatible resources with no execution capability', () => {
  expect(asMember(() => service.list('p'))).toEqual([
    expect.objectContaining({
      id: 'local',
      type: 'local',
      localPath: '/workspaces/p',
      capabilities: { read: true, write: true, execute: false },
      hasSecret: false,
    }),
  ]);
});

it('encrypts credentials and never returns them from resource views', () => {
  const resource = asAdmin(() =>
    service.create('p', {
      type: 'sftp',
      name: 'Documents',
      address: 'sftp://files.example.test',
      rootPath: '/exports/project',
      accessMode: 'read_only',
      secret: { username: 'maxime', password: 'top-secret' },
    }),
  );
  expect(resource).toMatchObject({
    type: 'sftp',
    hasSecret: true,
    accessMode: 'read_only',
  });
  expect(JSON.stringify(resource)).not.toContain('top-secret');
  const row = database.db.select().from(projectWorkspaceSecrets).get()!;
  expect(row.encryptedValue).not.toContain('top-secret');
  expect(row.encryptedValue).not.toContain('maxime');
});

it('requires explicit opt-in for plaintext FTP and confines the allowed root', () => {
  expect(() =>
    asAdmin(() =>
      service.create('p', {
        type: 'ftp',
        name: 'Legacy',
        address: 'ftp://files.example.test',
        rootPath: '/',
      }),
    ),
  ).toThrow('Plain FTP must be enabled explicitly');
  expect(() =>
    asAdmin(() =>
      service.create('p', {
        type: 'ftps',
        name: 'Escape',
        address: 'ftps://files.example.test',
        rootPath: '/../private',
      }),
    ),
  ).toThrow('Allowed root must not escape');
  expect(() =>
    asAdmin(() =>
      service.create('p', {
        type: 'git',
        name: 'Leaky URL',
        address: 'https://user:token@example.test/repo.git',
      }),
    ),
  ).toThrow('Credentials must be stored as a connection secret');
});

it('replaces Git credentials without exposing them and preserves them when omitted', () => {
  asAdmin(() => {
    const address = 'https://github.com/example/test.git';
    const resource = service.create('p', {
      type: 'git',
      name: 'Git',
      address,
      accessMode: 'read_write',
      secret: { token: 'old-fake-token' },
    });
    const updated = service.update('p', resource.id, {
      name: 'Git Test',
      expectedAddress: address,
      secret: { token: 'new-fake-token' },
    });
    expect(updated).toMatchObject({
      hasSecret: true,
      address,
      accessMode: 'read_write',
    });
    expect(JSON.stringify(updated)).not.toContain('new-fake-token');
    expect(service.resolveForTransfer('p', resource.id).secret?.token).toBe(
      'new-fake-token',
    );
    service.update('p', resource.id, {
      name: 'Renamed',
      expectedAddress: address,
    });
    expect(service.resolveForTransfer('p', resource.id).secret?.token).toBe(
      'new-fake-token',
    );
    expect(() =>
      service.update('p', resource.id, {
        expectedAddress: 'https://github.com/example/other.git',
        secret: { token: 'rejected-fake-token' },
      }),
    ).toThrow('Connection changed');
    expect(service.resolveForTransfer('p', resource.id).secret?.token).toBe(
      'new-fake-token',
    );
  });
});

it('detaches a definition without claiming to delete remote data', () => {
  const resource = asAdmin(() =>
    service.create('p', {
      type: 'git',
      name: 'Repo',
      address: 'https://example.test/repo.git',
      rootPath: '/',
    }),
  );
  expect(asAdmin(() => service.detach('p', resource.id))).toEqual({
    ok: true,
    remoteDataDeleted: false,
  });
  expect(asMember(() => service.list('p')).map((item) => item.id)).toEqual([
    'local',
  ]);
});

it('lets participants read resources but reserves connection changes to administrators', () => {
  expect(asMember(() => service.list('p'))).toHaveLength(1);
  expect(() =>
    asMember(() =>
      service.create('p', {
        type: 'git',
        name: 'Repo',
        address: 'https://example.test/repo.git',
      }),
    ),
  ).toThrow('Administrator access required');
});
