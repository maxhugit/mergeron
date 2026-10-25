/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- HTTP response doubles and asymmetric matchers. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  projects,
  projectWorkspaceResources,
  projectWorkspaces,
} from '../database/schema';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { parseGitChanges, WorkspaceGitService } from './workspace-git.service';

const exec = promisify(execFile);
let root: string;
let database: TestDatabase;
let resources: WorkspaceResourcesService;
let copies: WorkspaceCopiesService;
let service: WorkspaceGitService;
let copyId: string;
let cwd: string;
const git = (args: string[]) => exec('git', ['-C', cwd, ...args]);
beforeEach(async () => {
  database = createTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'workspace-git-test-'));
  const primary = path.join(root, 'project');
  const remote = path.join(root, 'remote');
  await mkdir(primary);
  await exec('git', ['init', '--initial-branch=main', remote]);
  cwd = remote;
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(cwd, 'README.md'), 'initial\n');
  await writeFile(path.join(cwd, 'other.md'), 'private comparison\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  const now = Date.now();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'P',
      workspacePath: primary,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectWorkspaces)
    .values({
      id: 'primary',
      projectId: 'p',
      name: 'Primary',
      path: primary,
      primary: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(projectWorkspaceResources)
    .values({
      id: 'remote',
      projectId: 'p',
      name: 'Git',
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
  service = new WorkspaceGitService(copies, resources);
  const copy = await copies.create('p', 'remote', {});
  copyId = copy.id;
  cwd = copy.localPath!;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  database.sqlite.close();
  await rm(root, { recursive: true, force: true });
});

it('inspects a registered read-only copy without modifying the index or worktree', async () => {
  const index = await readFile(path.join(cwd, '.git/index'));
  const result = await service.snapshot('p', copyId);
  expect(result).toMatchObject({
    branch: 'main',
    changes: [],
    ahead: 0,
    behind: 0,
  });
  expect(result.branches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'main', remote: false }),
    ]),
  );
  expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
});

it('compares staged and unstaged changes; literal glob filenames cannot select other files', async () => {
  await writeFile(path.join(cwd, 'README.md'), 'staged\n');
  await git(['add', 'README.md']);
  await writeFile(path.join(cwd, 'README.md'), 'unstaged\n');
  expect((await service.diff('p', copyId, 'README.md')).diff).toContain(
    '+unstaged',
  );
  await writeFile(path.join(cwd, '[x].md'), 'literal\n');
  await git(['add', '[x].md']);
  await writeFile(path.join(cwd, 'other.md'), 'SECRET-MUST-NOT-BE-IN-DIFF\n');
  const result = await service.diff('p', copyId, '[x].md');
  expect(result.diff).toContain('+literal');
  expect(result.diff).not.toContain('SECRET-MUST');
});

it('supports unicode, spaces, newlines, renamed and untracked filenames', async () => {
  await git(['mv', 'README.md', 'éspace\n name.md']);
  await writeFile(path.join(cwd, 'new file.md'), 'new\n');
  const snapshot = await service.snapshot('p', copyId);
  expect(snapshot.changes).toEqual(
    expect.arrayContaining([
      { path: 'éspace\n name.md', originalPath: 'README.md', status: 'R ' },
      { path: 'new file.md', status: '??' },
    ]),
  );
  expect(await service.diff('p', copyId, 'new file.md')).toMatchObject({
    untracked: true,
    diff: '',
  });
});

it('rejects cross-project copies, unknown paths and option injection', async () => {
  await expect(service.snapshot('other', copyId)).rejects.toThrow('not found');
  for (const name of ['../outside', '--output=/tmp/leak', 'other.md'])
    await expect(service.diff('p', copyId, name)).rejects.toThrow();
});

it('refuses disabled resources, revoked copies and Git metadata indirection', async () => {
  resources.setEnabled('p', 'remote', false);
  await expect(service.snapshot('p', copyId)).rejects.toThrow('unavailable');
  resources.setEnabled('p', 'remote', true);
  await rename(path.join(cwd, '.git'), path.join(root, 'external-git'));
  await symlink(path.join(root, 'external-git'), path.join(cwd, '.git'));
  await expect(service.snapshot('p', copyId)).rejects.toThrow('metadata');
});

it('rejects external object stores and never invokes fsmonitor or external diff commands', async () => {
  const marker = path.join(root, 'executed');
  await git(['config', 'core.fsmonitor', `touch ${marker}`]);
  await git(['config', 'diff.external', `touch ${marker}`]);
  await writeFile(path.join(cwd, 'README.md'), 'changed\n');
  await service.snapshot('p', copyId);
  await service.diff('p', copyId, 'README.md');
  await expect(readFile(marker)).rejects.toThrow();
  await mkdir(path.join(cwd, '.git/objects/info'), { recursive: true });
  await writeFile(path.join(cwd, '.git/objects/info/alternates'), '/outside\n');
  await expect(service.snapshot('p', copyId)).rejects.toThrow(
    'External Git metadata',
  );
});

describe('provider adapter', () => {
  const githubResource = () =>
    resources.create('p', {
      type: 'git',
      name: 'GitHub',
      address: 'https://github.com/example/demo.git',
      rootPath: '/',
      accessMode: 'read_only',
      secret: { password: 'private-token' },
    });
  it('keeps generic Git independent from GitHub', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await service.pullRequests('p', 'remote')).toMatchObject({
      supported: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses a fixed API origin, scoped credentials and canonical safe PR URLs', async () => {
    const resource = githubResource();
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          number: 12,
          title: 'Feature',
          draft: false,
          head: { ref: 'feature', sha: 'a'.repeat(40) },
          base: { ref: 'main' },
          html_url: 'javascript:alert(1)',
        },
      ],
    });
    vi.stubGlobal('fetch', fetch);
    expect(await service.pullRequests('p', resource.id)).toMatchObject({
      supported: true,
      items: [{ number: 12, url: 'https://github.com/example/demo/pull/12' }],
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(
        /^https:\/\/api.github.com\/repos\/example\/demo\/pulls\?/,
      ),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer private-token',
        }),
      }),
    );
  });
  it('combines check runs and commit statuses without turning unknown mergeability into success', async () => {
    const resource = githubResource();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          head: { sha: 'b'.repeat(40) },
          mergeable: null,
          mergeable_state: 'unknown',
          draft: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total_count: 101,
          check_runs: [
            {
              id: 1,
              name: 'build',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total_count: 1,
          statuses: [{ id: 2, context: 'review', state: 'pending' }],
        }),
      });
    vi.stubGlobal('fetch', fetch);
    expect(await service.checks('p', resource.id, '12')).toMatchObject({
      mergeable: null,
      limited: true,
      items: [{ status: 'success' }, { status: 'pending' }],
    });
  });
  it('does not relay provider errors or credentials and validates PR numbers', async () => {
    const resource = githubResource();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('private-token')),
    );
    await expect(service.pullRequests('p', resource.id)).rejects.toThrow(
      'GitHub is unavailable',
    );
    await expect(
      service.checks('p', resource.id, '../secrets'),
    ).rejects.toThrow('Invalid pull request');
  });
});

it('parses porcelain without splitting whitespace or renames into phantom changes', () => {
  expect(
    parseGitChanges(' M hello world\0R  new\0old\0?? new\nfile\0'),
  ).toEqual([
    { path: 'hello world', status: ' M' },
    { path: 'new', originalPath: 'old', status: 'R ' },
    { path: 'new\nfile', status: '??' },
  ]);
});
