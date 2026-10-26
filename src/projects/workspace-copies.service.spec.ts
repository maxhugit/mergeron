import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodexService } from '../codex/codex.service';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projectActiveFolders,
  projects,
  projectWorkspaceResources,
  projectWorkspaces,
} from '../database/schema';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { ProjectConnectionPolicyService } from '../threads/project-connection-policy.service';

const run = promisify(execFile);

describe('WorkspaceCopiesService', () => {
  let database: TestDatabase;
  let root: string;
  let primary: string;
  let remote: string;
  let resources: WorkspaceResourcesService;
  let copies: WorkspaceCopiesService;

  beforeEach(async () => {
    database = createTestDatabase();
    root = await mkdtemp(path.join(os.tmpdir(), 'workspace-copies-'));
    primary = path.join(root, 'project');
    remote = path.join(root, 'remote');
    await mkdir(primary, { recursive: true });
    await run('git', ['init', '--initial-branch=main', remote]);
    await run('git', [
      '-C',
      remote,
      'config',
      'user.email',
      'test@example.test',
    ]);
    await run('git', ['-C', remote, 'config', 'user.name', 'Test']);
    await writeFile(path.join(remote, 'README.md'), 'source repository\n');
    await run('git', ['-C', remote, 'add', 'README.md']);
    await run('git', ['-C', remote, 'commit', '-m', 'initial']);

    const now = Date.now();
    database.db
      .insert(projects)
      .values({
        id: 'project',
        name: 'Project',
        workspacePath: primary,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectWorkspaces)
      .values({
        id: 'primary',
        projectId: 'project',
        name: 'Principal',
        path: primary,
        primary: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(projectWorkspaceResources)
      .values({
        id: 'git-source',
        projectId: 'project',
        name: 'Sources',
        type: 'git',
        address: remote,
        rootPath: '/',
        accessMode: 'read_only',
        capabilities: { read: true, write: false, execute: false },
        enabled: true,
        connectionState: 'connected',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    resources = new WorkspaceResourcesService(
      database.db,
      new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'test-key' }),
    );
    copies = new WorkspaceCopiesService(database.db, resources);
  });

  afterEach(async () => {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  });

  it('creates isolated Git copies and retains their branch and revision', async () => {
    const first = await copies.create('project', 'git-source', {
      name: 'Main A',
      branch: 'main',
    });
    const second = await copies.create('project', 'git-source', {
      name: 'Main B',
      branch: 'main',
    });

    expect(first.localPath).not.toBe(second.localPath);
    expect(first).toMatchObject({
      branch: 'main',
      state: 'ready',
      accessMode: 'read_only',
      sourceEnabled: true,
    });
    expect(first.revision).toMatch(/^[0-9a-f]{40}$/);
    await expect(
      readFile(path.join(first.localPath!, 'README.md'), 'utf8'),
    ).resolves.toBe('source repository\n');
    const policy = new ProjectConnectionPolicyService(
      {
        request: vi.fn((method: string) =>
          Promise.resolve(
            method === 'config/read'
              ? { config: {} }
              : { data: [], nextCursor: null },
          ),
        ),
      } as unknown as CodexService,
      database.db,
      new ActiveFoldersService(database.db),
    );
    await expect(policy.policyForCwd(first.localPath)).resolves.toMatchObject({
      workspaceId: first.id,
      readOnly: true,
      sourceResourceId: 'git-source',
      sourceRevision: first.revision,
    });
  });

  it('revokes disabled sources and removes only the local copy', async () => {
    const copy = await copies.create('project', 'git-source', {
      branch: 'main',
    });
    database.db
      .insert(projectActiveFolders)
      .values({
        contextType: 'agent',
        contextId: 'thread',
        projectId: 'project',
        resourceId: copy.id,
        relativePath: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    resources.setEnabled('project', 'git-source', false);
    expect(copies.list('project')[0]).toMatchObject({
      id: copy.id,
      state: 'revoked',
      sourceEnabled: false,
    });
    const policy = new ProjectConnectionPolicyService(
      { request: vi.fn() } as unknown as CodexService,
      database.db,
      new ActiveFoldersService(database.db),
    );
    await expect(policy.policyForCwd(copy.localPath)).rejects.toThrow(
      'disabled or detached',
    );

    await expect(copies.remove('project', copy.id)).resolves.toEqual({
      ok: true,
      preservedRemote: true,
      activeReferencesPreserved: true,
    });
    await expect(
      readFile(path.join(remote, 'README.md'), 'utf8'),
    ).resolves.toBe('source repository\n');
    expect(database.db.select().from(projectActiveFolders).get()).toMatchObject(
      {
        contextId: 'thread',
        resourceId: copy.id,
      },
    );
    expect(copies.list('project')).toEqual([]);
  });
});
import { ActiveFoldersService } from '../active-folders/active-folders.service';
