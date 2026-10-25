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
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';
import type { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';

const exec = promisify(execFile);
let root: string;
let database: TestDatabase;
let resources: WorkspaceResourcesService;
let copies: WorkspaceCopiesService;
let service: WorkspaceGitService;
let actions: WorkspaceGitActionsService;
let active: string[];
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
  active = [];
  const gate = new GitMutationGateService(
    {
      snapshot: () => active,
    } as ThreadExecutionInventoryService,
    { getClient: () => ({}) } as CodexProcessManager,
  );
  actions = new WorkspaceGitActionsService(
    database.db,
    service,
    copies,
    resources,
    gate,
  );
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

it('clones an empty repository and supports the first staged commit without changing unstaged files', async () => {
  const remote = path.join(root, 'empty');
  await exec('git', ['init', '--initial-branch=main', remote]);
  database.sqlite
    .prepare(
      'UPDATE project_workspace_resources SET address = ?, access_mode = ? WHERE id = ?',
    )
    .run(remote, 'read_write', 'remote');
  const copy = await copies.create('p', 'remote', {});
  cwd = copy.localPath!;
  copyId = copy.id;
  expect(copy.revision).toBe('');
  const empty = await service.snapshot('p', copyId);
  expect(empty).toMatchObject({ head: '', branch: 'main', changes: [] });
  expect(empty.branches).toContainEqual(
    expect.objectContaining({ name: 'main', revision: '' }),
  );
  expect((await service.stagedDiff('p', copyId)).diff).toBe('');
  await expect(
    actions.push('p', copyId, {
      fingerprint: empty.fingerprint,
      address: remote,
    }),
  ).rejects.toThrow('GIT_NO_COMMIT');
  await writeFile(path.join(cwd, 'first.txt'), 'staged first\n');
  await git(['add', 'first.txt']);
  await writeFile(path.join(cwd, 'first.txt'), 'unstaged next\n');
  const diff = await service.diff('p', copyId, 'first.txt');
  expect(diff.stagedOnly).toBe(true);
  expect(diff.diff).toContain('+staged first');
  expect(diff.diff).not.toContain('unstaged next');
  const state = await service.snapshot('p', copyId);
  const result = await actions.commit('p', copyId, {
    fingerprint: state.fingerprint,
    message: 'First commit',
    authorName: 'Test',
    authorEmail: 'test@example.invalid',
  });
  expect(
    (await git(['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout.trim(),
  ).toBe(result.sha);
  expect((await git(['show', 'HEAD:first.txt'])).stdout).toBe('staged first\n');
  expect(await readFile(path.join(cwd, 'first.txt'), 'utf8')).toBe(
    'unstaged next\n',
  );
});

it('returns a safe conflict for a nonexistent clone branch rather than an internal error', async () => {
  await expect(
    copies.create('p', 'remote', { branch: 'missing-branch' }),
  ).rejects.toMatchObject({
    response: expect.objectContaining({
      statusCode: 409,
      message: 'WORKSPACE_GIT_CLONE_FAILED',
    }),
  });
  expect(copies.list('p')).toHaveLength(1);
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

describe('confirmed actions', () => {
  const writable = () =>
    resources.update('p', 'remote', {
      accessMode: 'read_write',
      address: 'https://github.com/example/demo.git',
    });
  const staged = async () => {
    await writeFile(path.join(cwd, 'README.md'), 'staged\n');
    await git(['add', 'README.md']);
    return service.snapshot('p', copyId);
  };
  const identity = {
    message: 'Reviewed commit',
    authorName: 'Reviewer',
    authorEmail: 'reviewer@example.invalid',
  };

  it('commits the frozen reviewed index and preserves unstaged changes and the real index', async () => {
    writable();
    const state = await staged();
    await writeFile(path.join(cwd, 'README.md'), 'unstaged\n');
    const index = await readFile(path.join(cwd, '.git/index'));
    const preview = await service.stagedDiff('p', copyId);
    expect(preview.diff).toContain('+staged');
    expect(preview.diff).not.toContain('+unstaged');
    expect(preview.fingerprint).toBe(state.fingerprint);
    const result = await actions.commit('p', copyId, {
      ...identity,
      fingerprint: state.fingerprint,
    });
    expect((await git(['show', 'HEAD:README.md'])).stdout).toBe('staged\n');
    expect((await git(['rev-parse', 'HEAD^'])).stdout.trim()).toBe(state.head);
    expect(result.sha).toBe((await git(['rev-parse', 'HEAD'])).stdout.trim());
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'unstaged\n',
    );
    expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
  });
  it('blocks stale index, read-only resource, busy agent and empty commits', async () => {
    let state = await staged();
    await expect(
      actions.commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_READ_ONLY');
    writable();
    await git(['reset', 'HEAD', '--', 'README.md']);
    await expect(
      actions.commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_STALE');
    state = await service.snapshot('p', copyId);
    await expect(
      actions.commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_NOTHING_STAGED');
    active = ['running-agent'];
    await expect(
      actions.commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_BUSY');
  });
  it('does not run local hooks or signing when committing', async () => {
    writable();
    const state = await staged();
    const marker = path.join(root, 'hook-executed');
    await writeFile(
      path.join(cwd, '.git/hooks/pre-commit'),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o700 },
    );
    await git(['config', 'commit.gpgsign', 'true']);
    await git(['config', 'gpg.program', `/not/a/program`]);
    await actions.commit('p', copyId, {
      ...identity,
      fingerprint: state.fingerprint,
    });
    await expect(readFile(marker)).rejects.toThrow();
  });
  it('pushes only the reviewed SHA to the registered HTTPS source, with isolated config and no force', async () => {
    writable();
    resources.update('p', 'remote', {
      address: 'https://github.com/example/demo.git',
      secret: { password: 'test-password' },
    });
    const state = await service.snapshot('p', copyId);
    const original = service.git.bind(service) as WorkspaceGitService['git'];
    const pushed: string[][] = [];
    vi.spyOn(service, 'git').mockImplementation(
      async (directory, args, env, timeout) => {
        if (args.includes('push')) {
          pushed.push(args);
          expect(directory).not.toBe(cwd);
          expect(args).toContain(`${state.head}:refs/heads/main`);
          expect(args).not.toContain('--force');
          expect(args).not.toContain('--force-with-lease');
          expect(env?.MERGERON_GIT_PASSWORD).toBe('test-password');
          expect(args).toContain('http.followRedirects=false');
          expect(args).toContain('credential.helper=');
          return '';
        }
        return original(directory, args, env, timeout);
      },
    );
    await actions.push('p', copyId, {
      fingerprint: state.fingerprint,
      address: 'https://github.com/example/demo.git',
    });
    expect(pushed).toHaveLength(1);
  });
  it('refuses SSH pushes from this panel rather than using uncontrolled SSH configuration', async () => {
    writable();
    resources.update('p', 'remote', {
      address: 'git@github.com:example/demo.git',
    });
    const state = await service.snapshot('p', copyId);
    await expect(
      actions.push('p', copyId, {
        fingerprint: state.fingerprint,
        address: 'git@github.com:example/demo.git',
      }),
    ).rejects.toThrow('GIT_HTTPS_REQUIRED');
  });
  it('rechecks PR checks and both revisions, then sends the expected head to GitHub', async () => {
    const resource = resources.create('p', {
      type: 'git',
      name: 'GitHub',
      address: 'https://github.com/example/demo.git',
      rootPath: '/',
      accessMode: 'read_write',
      secret: { password: 'token' },
    });
    const state = {
      address: 'https://github.com/example/demo.git',
      head: 'a'.repeat(40),
      baseHead: 'b'.repeat(40),
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      limited: false,
      items: [{ id: 'build', name: 'build', status: 'success' }],
      inspectedAt: 1,
    };
    const checks = vi.spyOn(service, 'checks').mockResolvedValue(state);
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ merged: true, sha: 'c'.repeat(40) }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      actions.merge('p', resource.id, '12', {
        head: state.head,
        baseHead: 'old',
      }),
    ).rejects.toThrow('GIT_STALE');
    expect(fetch).not.toHaveBeenCalled();
    checks.mockResolvedValueOnce({
      ...state,
      items: [{ id: 'build', name: 'build', status: 'pending' }],
    });
    await expect(actions.merge('p', resource.id, '12', state)).rejects.toThrow(
      'GIT_MERGE_BLOCKED',
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      actions.merge('p', resource.id, '12', state),
    ).resolves.toMatchObject({ merged: true });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/demo/pulls/12/merge',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ sha: state.head, merge_method: 'merge' }),
        redirect: 'error',
      }),
    );
  });

  it('rejects changed push destinations and treats lost merge confirmation as uncertain', async () => {
    writable();
    const state = await service.snapshot('p', copyId);
    await expect(
      actions.push('p', copyId, {
        fingerprint: state.fingerprint,
        address: 'https://other.example/repo.git',
      }),
    ).rejects.toThrow('GIT_STALE');
    const resource = resources.create('p', {
      type: 'git',
      name: 'GitHub',
      address: 'https://github.com/example/demo.git',
      rootPath: '/',
      accessMode: 'read_write',
      secret: { password: 'token' },
    });
    const checks = {
      head: 'a'.repeat(40),
      baseHead: 'b'.repeat(40),
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      limited: false,
      items: [{ id: 'build', name: 'build', status: 'success' }],
      inspectedAt: 1,
    };
    vi.spyOn(service, 'checks').mockResolvedValue(checks);
    const fetch = vi.fn().mockRejectedValue(new Error('network lost'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      actions.merge('p', resource.id, '12', {
        ...checks,
        address: resource.address,
      }),
    ).rejects.toThrow('GIT_OUTCOME_UNKNOWN');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
