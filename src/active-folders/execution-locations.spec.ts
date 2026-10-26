import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projectAgentThreads,
  projectLocations,
  projects,
  projectWorkspaceCopies,
  projectWorkspaces,
} from '../database/schema';
import { ActiveFoldersService } from './active-folders.service';
import { WorkspaceResourcesService } from '../projects/workspace-resources.service';
import { ProjectConnectionPolicyService } from '../threads/project-connection-policy.service';
import type { CodexService } from '../codex/codex.service';

let database: TestDatabase;
let root: string;
let primary: string;
let copyPath: string;
let other: string;
let folders: ActiveFoldersService;
let resources: WorkspaceResourcesService;
let policies: ProjectConnectionPolicyService;
let request: Mock<(method: string) => Promise<unknown>>;
let sourceId: string;

beforeEach(() => {
  database = createTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'mergeron-execution-locations-'));
  primary = join(root, 'primary');
  copyPath = join(root, 'copy');
  other = join(root, 'other');
  for (const directory of [
    primary,
    copyPath,
    other,
    join(primary, 'documents'),
  ])
    mkdirSync(directory);
  database.db
    .insert(projects)
    .values([
      {
        id: 'p',
        name: 'P',
        workspacePath: primary,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'other',
        name: 'Other',
        workspacePath: other,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  database.db
    .insert(projectWorkspaces)
    .values([
      {
        id: 'primary',
        projectId: 'p',
        name: 'Primary',
        path: primary,
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'copy',
        projectId: 'p',
        name: 'Copy',
        path: copyPath,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'other',
        projectId: 'other',
        name: 'Other',
        path: other,
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  database.db
    .insert(projectAgentThreads)
    .values({
      threadId: 'existing',
      projectId: 'p',
      workspacePath: primary,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  folders = new ActiveFoldersService(database.db);
  resources = new WorkspaceResourcesService(
    database.db,
    new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'test-key' }),
  );
  sourceId = resources.create('p', {
    type: 'git',
    name: 'Git',
    address: 'https://example.test/repo.git',
    accessMode: 'read_only',
  }).id;
  database.db
    .insert(projectWorkspaceCopies)
    .values({
      id: 'copy-record',
      projectId: 'p',
      sourceResourceId: sourceId,
      localWorkspaceId: 'copy',
      name: 'Copy',
      revision: 'abc',
      state: 'ready',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  request = vi.fn((method: string) =>
    Promise.resolve(
      method === 'config/read'
        ? { config: {} }
        : { data: [], nextCursor: null },
    ),
  );
  policies = new ProjectConnectionPolicyService(
    { request } as unknown as CodexService,
    database.db,
    folders,
  );
});
afterEach(() => {
  database.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

it('selects a normalized local location and retains a confined subdirectory for existing conversations', async () => {
  const selection = folders.validateLocationSelection('p', {
    locationId: 'local:primary',
    relativePath: 'documents',
  });
  folders.set('p', 'agent', 'existing', selection);
  expect(folders.resolveAgent('existing')).toBe(join(primary, 'documents'));
  expect(
    await policies.policyForThread(
      'existing',
      folders.resolveAgent('existing'),
    ),
  ).toMatchObject({
    projectId: 'p',
    locationId: 'local:primary',
    workspaceId: 'primary',
    readOnly: false,
  });
});

it('rejects remote locations, foreign locations and traversal instead of choosing a fallback', () => {
  expect(() =>
    folders.validateLocationSelection('p', {
      locationId: `remote:${sourceId}`,
    }),
  ).toThrow('local working copy');
  expect(() =>
    folders.validateLocationSelection('p', { locationId: 'local:other' }),
  ).toThrow('not found');
  expect(() =>
    folders.validateLocationSelection('p', {
      locationId: 'local:primary',
      relativePath: '../other',
    }),
  ).toThrow('cannot leave');
});

it('rechecks copy revocation and readonly permissions on existing conversations', async () => {
  expect(await policies.policyForThread('existing', copyPath)).toMatchObject({
    locationId: 'local:copy',
    readOnly: true,
    sourceResourceId: sourceId,
    sourceRevision: 'abc',
  });
  resources.setEnabled('p', sourceId, false);
  request.mockClear();
  await expect(policies.policyForThread('existing', copyPath)).rejects.toThrow(
    'disabled or detached',
  );
  expect(request).not.toHaveBeenCalled();
  resources.setEnabled('p', sourceId, true);
  resources.update('p', sourceId, { accessMode: 'read_write' });
  expect(await policies.policyForThread('existing', copyPath)).toMatchObject({
    readOnly: false,
  });
  resources.detach('p', sourceId);
  await expect(
    policies.policyForThread('existing', copyPath),
  ).rejects.toThrow();
});

it('rejects missing locations and bound cwd escapes before native inventory calls', async () => {
  await expect(policies.policyForThread('existing', other)).rejects.toThrow(
    'ne correspond pas',
  );
  await expect(
    policies.policyForThread('existing', join(primary, 'missing')),
  ).rejects.toThrow('regular directory');
  database.db
    .delete(projectLocations)
    .where(eq(projectLocations.id, 'local:primary'))
    .run();
  await expect(policies.policyForThread('existing', primary)).rejects.toThrow(
    'not found',
  );
  expect(request).not.toHaveBeenCalled();
});

it('does not treat symlink aliases, including missing children, as projectless execution', async () => {
  const alias = join(root, 'alias');
  symlinkSync(primary, alias);
  await expect(policies.policyForCwd(alias)).rejects.toThrow('canonical');
  await expect(policies.policyForCwd(join(alias, 'missing'))).rejects.toThrow(
    'canonical',
  );
  symlinkSync(other, join(primary, 'escape'));
  await expect(
    policies.policyForThread('existing', join(primary, 'escape')),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it('fails closed if a source is disabled while native policy discovery is in progress', async () => {
  request.mockImplementation((method: string) => {
    if (method === 'config/read') resources.setEnabled('p', sourceId, false);
    return Promise.resolve(
      method === 'config/read'
        ? { config: {} }
        : { data: [], nextCursor: null },
    );
  });
  await expect(policies.policyForThread('existing', copyPath)).rejects.toThrow(
    'disabled or detached',
  );
});

it('leaves genuinely projectless execution unchanged', async () => {
  expect(await policies.policyForCwd(root)).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it('does not authorize a copy using a connection owned by another project', async () => {
  const foreign = resources.create('other', {
    type: 'git',
    name: 'Other Git',
    address: 'https://example.test/other.git',
  });
  database.db
    .update(projectWorkspaceCopies)
    .set({ sourceResourceId: foreign.id })
    .where(eq(projectWorkspaceCopies.id, 'copy-record'))
    .run();
  await expect(policies.policyForThread('existing', copyPath)).rejects.toThrow(
    'disabled or detached',
  );
  expect(request).not.toHaveBeenCalled();
});
