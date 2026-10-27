import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  rename,
  symlink,
} from 'node:fs/promises';
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
  projectAgentThreads,
} from '../database/schema';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { ProjectConnectionPolicyService } from '../threads/project-connection-policy.service';
import type { GitMutationGateService } from '../threads/git-mutation-gate.service';

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
    copies = new WorkspaceCopiesService(database.db, resources, {
      mutate: (operation: () => Promise<unknown>) => operation(),
    } as GitMutationGateService);
  });

  afterEach(async () => {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reserves a new copy for its work agent and rejects a second clone before creating files', async () => {
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'work-agent',
        projectId: 'project',
        workspacePath: primary,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const copy = await copies.create('project', 'git-source', {
      agentThreadId: 'work-agent',
    });
    expect(copy.ownerAgentIds).toEqual(['work-agent']);
    await expect(
      copies.create('project', 'git-source', { agentThreadId: 'work-agent' }),
    ).rejects.toThrow('GIT_AGENT_COPY_EXISTS');
    expect(copies.list('project')).toHaveLength(1);
    expect(
      await readFile(path.join(copy.localPath!, 'README.md'), 'utf8'),
    ).toBe('source repository\n');
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

    const input = { confirmation: 'REMOVE_WORKING_COPY', path: copy.localPath };
    await expect(copies.remove('project', copy.id, input)).rejects.toThrow(
      'GIT_COPY_IN_USE',
    );
    database.db.delete(projectActiveFolders).run();
    const result = await copies.remove('project', copy.id, input);
    expect(result).toMatchObject({
      ok: true,
      preservedRemote: true,
      activeReferencesPreserved: true,
      preservedLocal: true,
    });
    expect(
      await readFile(path.join(result.recoveryPath, 'README.md'), 'utf8'),
    ).toBe('source repository\n');
    await expect(
      readFile(path.join(remote, 'README.md'), 'utf8'),
    ).resolves.toBe('source repository\n');
    expect(
      database.db.select().from(projectActiveFolders).get(),
    ).toBeUndefined();
    expect(copies.list('project')).toEqual([]);
  });

  it('requires confirmation and the current path before touching files', async () => {
    const copy = await copies.create('project', 'git-source', {});
    await expect(copies.remove('project', copy.id)).rejects.toThrow(
      'GIT_COPY_CONFIRMATION_REQUIRED',
    );
    await expect(
      copies.remove('project', copy.id, {
        confirmation: 'REMOVE_WORKING_COPY',
        path: remote,
      }),
    ).rejects.toThrow('GIT_STALE');
    expect(
      await readFile(path.join(copy.localPath!, 'README.md'), 'utf8'),
    ).toBe('source repository\n');
    expect(copies.list('project')).toHaveLength(1);
  });

  it('preserves dirty files and unpublished commits while removing only the selected duplicate', async () => {
    const first = await copies.create('project', 'git-source', {
      name: 'Same name',
    });
    const second = await copies.create('project', 'git-source', {
      name: 'Same name',
    });
    await run('git', [
      '-C',
      first.localPath!,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'unpublished',
    ]);
    const { stdout: head } = await run('git', [
      '-C',
      first.localPath!,
      'rev-parse',
      'HEAD',
    ]);
    await writeFile(path.join(first.localPath!, 'README.md'), 'dirty changes');
    await writeFile(path.join(first.localPath!, 'untracked.txt'), 'keep me');
    const result = await copies.remove('project', first.id, {
      confirmation: 'REMOVE_WORKING_COPY',
      path: first.localPath,
    });
    expect(
      await readFile(path.join(result.recoveryPath, 'README.md'), 'utf8'),
    ).toBe('dirty changes');
    expect(
      await readFile(path.join(result.recoveryPath, 'untracked.txt'), 'utf8'),
    ).toBe('keep me');
    expect(
      (await run('git', ['-C', result.recoveryPath, 'rev-parse', 'HEAD']))
        .stdout,
    ).toBe(head);
    expect(
      await readFile(path.join(second.localPath!, 'README.md'), 'utf8'),
    ).toBe('source repository\n');
    expect(copies.list('project').map((item) => item.id)).toEqual([second.id]);
  });

  it('rejects symlink replacements without moving the linked data', async () => {
    const copy = await copies.create('project', 'git-source', {});
    const preserved = path.join(root, 'preserved');
    await rename(copy.localPath!, preserved);
    await symlink(remote, copy.localPath!);
    await expect(
      copies.remove('project', copy.id, {
        confirmation: 'REMOVE_WORKING_COPY',
        path: copy.localPath,
      }),
    ).rejects.toThrow('GIT_COPY_PATH_UNSAFE');
    expect(await readFile(path.join(remote, 'README.md'), 'utf8')).toBe(
      'source repository\n',
    );
    expect(copies.list('project')).toHaveLength(1);
  });

  it('blocks references through a parent workspace relative path', async () => {
    const copy = await copies.create('project', 'git-source', {});
    database.db
      .insert(projectActiveFolders)
      .values({
        contextType: 'agent',
        contextId: 'thread',
        projectId: 'project',
        resourceId: 'local:primary',
        relativePath: path.relative(primary, copy.localPath!),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    await expect(
      copies.remove('project', copy.id, {
        confirmation: 'REMOVE_WORKING_COPY',
        path: copy.localPath,
      }),
    ).rejects.toThrow('GIT_COPY_IN_USE');
    expect(
      await readFile(path.join(copy.localPath!, 'README.md'), 'utf8'),
    ).toBe('source repository\n');
  });
});
import { ActiveFoldersService } from '../active-folders/active-folders.service';
