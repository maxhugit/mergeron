/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- HTTP response doubles and asymmetric matchers. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
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
  projectAgentThreads,
  people,
} from '../database/schema';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import {
  gitFailureCode,
  parseGitChanges,
  WorkspaceGitService,
} from './workspace-git.service';
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import { accessContext } from '../auth/access-context';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { agentCopyPermissions } from './agent-copy-permissions';
import { claimAgentCopy } from './git-copy-ownership';
import { gitCredentialHelper } from './git-credentials';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';
import type { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';

const exec = promisify(execFile);
it.each([
  [
    'fatal: Authentication failed for https://secret@example.test',
    'GIT_AUTH_REQUIRED',
  ],
  [
    'remote: Permission to example/demo.git denied to user',
    'GIT_WRITE_ACCESS_DENIED',
  ],
  ['! [rejected] main -> main (fetch first)', 'GIT_REMOTE_REJECTED'],
  ['fatal: requested URL returned error: 403', 'GIT_WRITE_ACCESS_DENIED'],
  [
    'remote: Write access to repository not granted.',
    'GIT_WRITE_ACCESS_DENIED',
  ],
  ['Could not resolve proxy: private-host', 'GIT_NETWORK_UNAVAILABLE'],
  [
    'SSL certificate problem: unable to get local issuer certificate',
    'GIT_TLS_ERROR',
  ],
  [
    'unknown diagnostic with secret-token',
    'Git inspection failed or exceeded its limit',
  ],
])('sanitizes Git failure %s', (diagnostic, code) => {
  expect(gitFailureCode(diagnostic)).toBe(code);
});
let root: string;
let database: TestDatabase;
let resources: WorkspaceResourcesService;
let copies: WorkspaceCopiesService;
let service: WorkspaceGitService;
let actions: WorkspaceGitActionsService;
let active: string[];
let gate: GitMutationGateService;
let copyId: string;
let cwd: string;
const connectedPerson: PlatformIdentity = {
  kind: 'person',
  personId: 'reviewer-person',
  name: 'Reviewer',
  email: 'reviewer@example.invalid',
  active: true,
  role: 'administrator',
};
const asPerson = <T>(run: () => T, identity = connectedPerson) =>
  accessContext.run(
    { identity, identities: new IdentityService(database.db) },
    run,
  );
const commit = (...args: Parameters<WorkspaceGitActionsService['commit']>) =>
  asPerson(() => actions.commit(...args));
const git = (args: string[]) => exec('git', ['-C', cwd, ...args]);
beforeEach(async () => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values({
      id: 'reviewer-person',
      reference: 'TEST-REVIEWER',
      name: 'Reviewer',
      email: 'reviewer@example.invalid',
      role: 'administrator',
      active: true,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
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
  gate = new GitMutationGateService(
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

it('ignores root and nested build caches without hiding tracked cache files or ordinary edits', async () => {
  await writeFile(
    path.join(cwd, '.gitignore'),
    await readFile(new URL('../../.gitignore', import.meta.url)),
  );
  for (const relative of ['.build-cache', 'web/.build-cache']) {
    await mkdir(path.join(cwd, relative), { recursive: true });
    await writeFile(path.join(cwd, relative, 'package-cache.txt'), 'generated');
  }
  await writeFile(
    path.join(cwd, '.build-cache', 'already-tracked.txt'),
    'keep staged',
  );
  await git(['add', '--force', '.build-cache/already-tracked.txt']);
  await writeFile(path.join(cwd, 'source.ts'), 'normal edit');
  const index = await readFile(path.join(cwd, '.git', 'index'));
  const snapshot = await service.snapshot('p', copyId);
  expect(
    snapshot.changes.some((item) => item.path.endsWith('package-cache.txt')),
  ).toBe(false);
  expect(snapshot.changes).toContainEqual({ path: 'source.ts', status: '??' });
  expect(snapshot.changes).toContainEqual({
    path: '.build-cache/already-tracked.txt',
    status: 'A ',
  });
  expect(await readFile(path.join(cwd, '.git', 'index'))).toEqual(index);
});

it('clones an empty repository and supports the first staged commit without changing unstaged files', async () => {
  const remote = path.join(root, 'empty');
  await exec('git', ['init', '--initial-branch=main', remote]);
  database.sqlite
    .prepare(
      'UPDATE project_workspace_resources SET address = ?, access_mode = ?, capabilities = ? WHERE id = ?',
    )
    .run(
      remote,
      'read_write',
      JSON.stringify({ read: true, write: true, execute: false }),
      'remote',
    );
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
  expect((await service.commits('p', copyId)).items).toEqual([]);
  await expect(
    actions.push('p', copyId, {
      fingerprint: empty.fingerprint,
      address: remote,
    }),
  ).rejects.toThrow('GIT_NO_COMMIT');
  await writeFile(path.join(cwd, 'first.txt'), 'staged first\n');
  const initial = await service.snapshot('p', copyId);
  const initialBody = {
    paths: ['first.txt'],
    fingerprint: initial.fingerprint,
  };
  const initialReview = await actions.stageReview('p', copyId, initialBody);
  await actions.stage('p', copyId, {
    ...initialBody,
    reviewFingerprint: initialReview.reviewFingerprint,
  });
  const preparedInitial = await service.snapshot('p', copyId);
  await actions.unstage('p', copyId, {
    paths: ['first.txt'],
    fingerprint: preparedInitial.fingerprint,
  });
  expect(await readFile(path.join(cwd, 'first.txt'), 'utf8')).toBe(
    'staged first\n',
  );
  const unstagedInitial = await service.snapshot('p', copyId);
  const repeatBody = {
    ...initialBody,
    fingerprint: unstagedInitial.fingerprint,
  };
  const repeatReview = await actions.stageReview('p', copyId, repeatBody);
  await actions.stage('p', copyId, {
    ...repeatBody,
    reviewFingerprint: repeatReview.reviewFingerprint,
  });
  await writeFile(path.join(cwd, 'first.txt'), 'unstaged next\n');
  const diff = await service.diff('p', copyId, 'first.txt');
  expect(diff.stagedOnly).toBe(true);
  expect(diff.diff).toContain('+staged first');
  expect(diff.diff).not.toContain('unstaged next');
  const state = await service.snapshot('p', copyId);
  const result = await commit('p', copyId, {
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

it('reads local commits without accessing the remote or modifying the copy', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const index = await readFile(path.join(cwd, '.git/index'));
  const history = await service.commits('p', copyId);
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({
    subject: 'initial',
    author: 'Test',
  });
  expect(history.items[0].sha).toMatch(/^[a-f0-9]{40,64}$/);
  expect(fetch).not.toHaveBeenCalled();
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

it('returns a topological graph with both merge parents and local/remote branch labels', async () => {
  await git(['switch', '-c', 'feature']);
  await writeFile(path.join(cwd, 'feature.txt'), 'feature\n');
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Feature',
  ]);
  await git(['switch', 'main']);
  await writeFile(path.join(cwd, 'main.txt'), 'main\n');
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Main',
  ]);
  await git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'merge',
    '--no-ff',
    'feature',
    '-m',
    'Merge feature',
  ]);
  const before = (await git(['status', '--porcelain'])).stdout;
  const graph = await service.graph('p', copyId);
  expect(graph.items[0].subject).toBe('Merge feature');
  expect(graph.items[0].parents).toHaveLength(2);
  expect(graph.items[0].current).toBe(true);
  expect(graph.items[0].refs).toContainEqual({ name: 'main', remote: false });
  expect(graph.items.find((c) => c.subject === 'Feature')?.refs).toContainEqual(
    { name: 'feature', remote: false },
  );
  expect(graph.items.some((c) => c.refs.some((r) => r.remote))).toBe(true);
  expect((await git(['status', '--porcelain'])).stdout).toBe(before);
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
  it('reads a bounded remote graph without touching a local copy, even with inverted dates', async () => {
    const resource = githubResource();
    const parent = 'a'.repeat(40),
      child = 'b'.repeat(40);
    const fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('/branches?')
          ? [{ name: 'main', commit: { sha: child }, protected: true }]
          : [
              {
                sha: parent,
                parents: [],
                commit: {
                  author: { name: 'A', date: '2026-10-28' },
                  message: 'Parent',
                },
              },
              {
                sha: child,
                parents: [{ sha: parent }],
                commit: {
                  author: { name: 'A', date: '2026-10-27' },
                  message: 'Child\nbody',
                },
              },
            ],
    }));
    vi.stubGlobal('fetch', fetch);
    const local = vi.spyOn(service, 'directory');
    const result = await service.remoteGraph('p', resource.id);
    expect(result.items.map((c) => c.sha)).toEqual([child, parent]);
    expect(result.items[0]).toMatchObject({
      subject: 'Child',
      current: false,
      refs: [{ name: 'main', remote: true }],
    });
    expect(local).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('pins remote file navigation and never follows response URLs or exposes credentials', async () => {
    const resource = githubResource(),
      ref = 'c'.repeat(40);
    const fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('commits?per_page=1')
          ? [{ sha: ref }]
          : url.includes('contents/?')
            ? [
                {
                  name: 'coucou.js',
                  path: 'coucou.js',
                  type: 'file',
                  size: 7,
                  download_url: 'https://untrusted.test/',
                },
              ]
            : {
                type: 'file',
                size: 7,
                encoding: 'base64',
                content: Buffer.from('coucou!').toString('base64'),
              },
    }));
    vi.stubGlobal('fetch', fetch);
    const root = await service.remoteFiles('p', resource.id, '', undefined);
    expect(root).toMatchObject({ ref, items: [{ name: 'coucou.js' }] });
    expect(JSON.stringify(root)).not.toContain('download_url');
    const file = await service.remoteFiles('p', resource.id, 'coucou.js', ref);
    expect(file.content).toBe('coucou!');
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/repos/example/demo/commits?per_page=1',
      `https://api.github.com/repos/example/demo/contents/?ref=${ref}`,
      `https://api.github.com/repos/example/demo/contents/coucou.js?ref=${ref}`,
    ]);
    await expect(
      service.remoteFiles('p', resource.id, '../private', ref),
    ).rejects.toThrow('Invalid remote path');
    await expect(
      service.remoteFiles('p', resource.id, '', 'main&token=x'),
    ).rejects.toThrow('Invalid remote revision');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('does not preview oversized or binary remote files, and supports empty repositories', async () => {
    const resource = githubResource(),
      ref = 'c'.repeat(40);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        type: 'file',
        size: 200000,
        content: 'secret',
        encoding: 'base64',
      }),
    });
    vi.stubGlobal('fetch', fetch);
    expect(
      (await service.remoteFiles('p', resource.id, 'large', ref)).content,
    ).toBeNull();
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: 'file',
        size: 2,
        content: Buffer.from([0, 1]).toString('base64'),
        encoding: 'base64',
      }),
    });
    expect(
      (await service.remoteFiles('p', resource.id, 'binary', ref)).content,
    ).toBeNull();
    fetch.mockResolvedValue({ ok: false, status: 409 });
    expect(
      await service.remoteFiles('p', resource.id, '', undefined),
    ).toMatchObject({ ref: null, items: [] });
  });
  it('keeps generic Git independent from GitHub', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await service.pullRequests('p', 'remote')).toMatchObject({
      supported: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await service.remoteBranches('p', 'remote')).toMatchObject({
      supported: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads published branches directly from the fixed GitHub API without a local copy', async () => {
    const resource = githubResource();
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          name: 'published-only',
          commit: { sha: 'b'.repeat(40) },
          protected: true,
        },
      ],
    });
    vi.stubGlobal('fetch', fetch);
    expect(await service.remoteBranches('p', resource.id)).toMatchObject({
      supported: true,
      items: [
        { name: 'published-only', revision: 'b'.repeat(40), protected: true },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/demo/branches?per_page=100',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer private-token',
        }),
      }),
    );
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

describe('PR creation from published branches', () => {
  const input = {
    confirmation: 'CREATE_REMOTE_PULL_REQUEST',
    branch: 'published/elsewhere',
    head: 'c'.repeat(40),
    address: 'https://github.com/example/demo.git',
    base: 'main',
    title: 'Remote proposal',
    description: 'User text',
    draft: true,
  };
  const prepare = () => {
    resources.update('p', 'remote', {
      accessMode: 'read_write',
      address: input.address,
      secret: { token: 'pr-token' },
    });
    const prepared = vi
      .spyOn(service, 'pullRequestPreparation')
      .mockResolvedValue({
        head: input.head,
        baseHead: 'd'.repeat(40),
        existingNumber: null,
      });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ number: 42 }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetch);
    return { prepared, fetch };
  };
  it.each([
    'https://github.com/example/demo.git',
    'git@github.com:example/demo.git',
  ])(
    'creates a PR using GitHub only with source %s and no copy or push receipt',
    async (address) => {
      const { prepared, fetch } = prepare();
      resources.update('p', 'remote', { address });
      const git = vi
        .spyOn(service, 'git')
        .mockRejectedValue(new Error('Must not run local Git'));
      const snapshot = vi
        .spyOn(service, 'snapshot')
        .mockRejectedValue(new Error('No local copy'));
      const copiesList = vi.spyOn(copies, 'list').mockImplementation(() => {
        throw new Error('No local copy');
      });
      await expect(
        actions.createRemotePullRequest('p', 'remote', { ...input, address }),
      ).resolves.toMatchObject({
        number: 42,
        existing: false,
        url: 'https://github.com/example/demo/pull/42',
      });
      expect(prepared).toHaveBeenCalledWith(
        'p',
        'remote',
        input.branch,
        'main',
      );
      expect(fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/example/demo/pulls',
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
          body: JSON.stringify({
            title: input.title,
            body: input.description,
            head: input.branch,
            base: 'main',
            draft: true,
            maintainer_can_modify: false,
          }),
        }),
      );
      expect(git).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(copiesList).not.toHaveBeenCalled();
    },
  );
  it('links the existing matching PR without another POST', async () => {
    const { prepared, fetch } = prepare();
    prepared.mockResolvedValue({
      head: input.head,
      baseHead: 'd'.repeat(40),
      existingNumber: 21,
    });
    await expect(
      actions.createRemotePullRequest('p', 'remote', input),
    ).resolves.toEqual({
      number: 21,
      existing: true,
      url: 'https://github.com/example/demo/pull/21',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses stale source revisions, missing branches and invalid confirmation before posting', async () => {
    const { prepared, fetch } = prepare();
    for (const override of [
      { confirmation: 'CREATE_PULL_REQUEST' },
      { head: 'HEAD' },
      { branch: 'bad\nbranch' },
      { base: input.branch },
      { title: '' },
    ])
      await expect(
        actions.createRemotePullRequest('p', 'remote', {
          ...input,
          ...override,
        }),
      ).rejects.toThrow();
    expect(prepared).not.toHaveBeenCalled();
    prepared.mockResolvedValueOnce({
      head: 'f'.repeat(40),
      baseHead: 'd'.repeat(40),
      existingNumber: null,
    });
    await expect(
      actions.createRemotePullRequest('p', 'remote', input),
    ).rejects.toThrow('GIT_STALE');
    prepared.mockRejectedValueOnce(new Error('Missing remote branch'));
    await expect(
      actions.createRemotePullRequest('p', 'remote', input),
    ).rejects.toThrow('Missing remote branch');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires administrator, writable connection and credentials', async () => {
    const { fetch } = prepare();
    resources.update('p', 'remote', { accessMode: 'read_only' });
    await expect(
      actions.createRemotePullRequest('p', 'remote', input),
    ).rejects.toThrow('GIT_READ_ONLY');
    resources.update('p', 'remote', { accessMode: 'read_write', secret: null });
    await expect(
      actions.createRemotePullRequest('p', 'remote', input),
    ).rejects.toThrow('GIT_GITHUB_TOKEN_REQUIRED');
    database.sqlite
      .prepare("UPDATE people SET role='standard' WHERE id=?")
      .run(connectedPerson.personId);
    await expect(
      asPerson(() => actions.createRemotePullRequest('p', 'remote', input)),
    ).rejects.toThrow('Administrator');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['address', 'credentials', 'read-only'] as const)(
    'rechecks %s after remote preparation',
    async (change) => {
      const { prepared, fetch } = prepare();
      prepared.mockImplementationOnce(async () => {
        resources.update(
          'p',
          'remote',
          change === 'address'
            ? { address: 'https://github.com/other/repo.git' }
            : change === 'credentials'
              ? { secret: { token: 'rotated' } }
              : { accessMode: 'read_only' },
        );
        return {
          head: input.head,
          baseHead: 'd'.repeat(40),
          existingNumber: null,
        };
      });
      await expect(
        actions.createRemotePullRequest('p', 'remote', input),
      ).rejects.toThrow(change === 'read-only' ? 'GIT_READ_ONLY' : 'GIT_STALE');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('does not automatically retry an uncertain GitHub write', async () => {
    const { fetch } = prepare();
    fetch.mockRejectedValue(new Error('connection ended'));
    await expect(
      actions.createRemotePullRequest('p', 'remote', input),
    ).rejects.toThrow('GIT_OUTCOME_UNKNOWN');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('remote branch retrieval', () => {
  const writable = () =>
    resources.update('p', 'remote', {
      accessMode: 'read_write',
      address: 'https://github.com/example/demo.git',
    });
  const prepare = async () => {
    writable();
    resources.update('p', 'remote', {
      address: 'https://github.com/example/demo.git',
      secret: { password: 'retrieve-test-secret' },
    });
    const remote = path.join(root, 'remote');
    await exec('git', ['-C', remote, 'switch', '-c', 'dev']);
    await writeFile(
      path.join(remote, 'remote-only.txt'),
      'remote branch content\n',
    );
    await exec('git', ['-C', remote, 'add', '.']);
    await exec('git', ['-C', remote, 'commit', '-m', 'remote dev commit']);
    const revision = (
      await exec('git', ['-C', remote, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const state = await service.snapshot('p', copyId);
    return {
      name: 'dev',
      revision,
      fingerprint: state.fingerprint,
      address: 'https://github.com/example/demo.git',
      confirmation: 'RETRIEVE_REMOTE_BRANCH',
    };
  };
  const fixtureTransport = (
    beforeFetch?: () => Promise<void>,
    beforeCreate?: () => Promise<void>,
  ) => {
    const runGit = service.git.bind(service) as WorkspaceGitService['git'];
    let calls = 0;
    vi.spyOn(service, 'git').mockImplementation(
      async (dir, args, env, timeout, accepted, input) => {
        if (args.includes('fetch')) {
          calls++;
          expect(dir).not.toBe(cwd);
          expect(args).toContain('https://github.com/example/demo.git');
          expect(args).toContain('refs/heads/dev:refs/mergeron/retrieved');
          expect(args).toContain('http.followRedirects=false');
          expect(args).toContain('http.sslVerify=true');
          expect(args).toContain('protocol.allow=never');
          expect(args).toContain(`credential.helper=${gitCredentialHelper}`);
          expect(args.join(' ')).not.toContain('retrieve-test-secret');
          expect(env?.MERGERON_GIT_TOKEN).toBe('retrieve-test-secret');
          expect(env?.GIT_OBJECT_DIRECTORY).toBe(
            path.join(await realpath(cwd), '.git/objects'),
          );
          await beforeFetch?.();
          // Fixture-only transport substitution. Production accepts HTTPS only.
          return runGit(
            dir,
            [
              '-c',
              'protocol.file.allow=always',
              'fetch',
              '--no-tags',
              '--no-recurse-submodules',
              '--no-auto-maintenance',
              '--no-write-fetch-head',
              '--',
              path.join(root, 'remote'),
              'refs/heads/dev:refs/mergeron/retrieved',
            ],
            env,
            timeout,
          );
        }
        if (args[0] === 'update-ref' && args.includes('--stdin'))
          await beforeCreate?.();
        return runGit(dir, args, env, timeout, accepted, input);
      },
    );
    return () => calls;
  };
  it('replaces tracked local state from a pinned GitHub tip while keeping raw recovery, local history and untracked files', async () => {
    const input = await prepare();
    await writeFile(path.join(cwd, 'other.md'), 'local commit\n');
    await git(['add', 'other.md']);
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'local only',
    ]);
    const oldHead = (await service.snapshot('p', copyId)).head;
    await writeFile(path.join(cwd, 'README.md'), 'prepared work\n');
    await git(['add', 'README.md']);
    await writeFile(path.join(cwd, 'README.md'), 'working work\n');
    await writeFile(path.join(cwd, 'untracked.txt'), 'keep untracked\n');
    await writeFile(path.join(cwd, '.git/info/exclude'), 'ignored-cache.tmp\n');
    await writeFile(path.join(cwd, 'ignored-cache.tmp'), 'keep ignored\n');
    input.fingerprint = (await service.snapshot('p', copyId)).fingerprint;
    fixtureTransport();
    vi.spyOn(service, 'remoteBranches').mockResolvedValue({
      supported: true,
      items: [{ name: 'dev', revision: input.revision, protected: false }],
      limited: false,
      inspectedAt: 1,
    });
    const body = { ...input, target: 'github' };
    const review = await asPerson(() =>
      actions.restoreReview('p', copyId, body),
    );
    expect(review.localCommits).toBe(1);
    expect((await service.snapshot('p', copyId)).head).toBe(oldHead);
    const result = await asPerson(() =>
      actions.restore('p', copyId, {
        ...body,
        reviewFingerprint: review.reviewFingerprint,
        confirmation: 'RESTORE_GITHUB_STATE',
      }),
    );
    expect(result.restored).toBe(true);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'initial\n',
    );
    expect(await readFile(path.join(cwd, 'remote-only.txt'), 'utf8')).toBe(
      'remote branch content\n',
    );
    expect(await readFile(path.join(cwd, 'untracked.txt'), 'utf8')).toBe(
      'keep untracked\n',
    );
    expect(await readFile(path.join(cwd, 'ignored-cache.tmp'), 'utf8')).toBe(
      'keep ignored\n',
    );
    expect(await service.snapshot('p', copyId)).toMatchObject({
      branch: 'main',
      head: input.revision,
      changes: [{ path: 'untracked.txt', status: '??' }],
    });
    expect(
      (await git(['rev-parse', `${result.backupBranch}^1`])).stdout.trim(),
    ).toBe(oldHead);
    expect(
      (await git(['show', `${result.backupBranch}:README.md`])).stdout,
    ).toBe('working work\n');
    expect(
      (await git(['show', `${result.backupBranch}^2:README.md`])).stdout,
    ).toBe('prepared work\n');
  }, 30000);

  it('refuses a GitHub replacement when an untracked file would be overwritten or the remote tip changed', async () => {
    const input = await prepare();
    fixtureTransport();
    await writeFile(path.join(cwd, 'remote-only.txt'), 'precious\n');
    const body = { ...input, target: 'github' };
    await expect(
      asPerson(() => actions.restoreReview('p', copyId, body)),
    ).rejects.toThrow('GIT_RESTORE_COLLISION');
    expect(await readFile(path.join(cwd, 'remote-only.txt'), 'utf8')).toBe(
      'precious\n',
    );
    await rm(path.join(cwd, 'remote-only.txt'));
    const review = await asPerson(() =>
      actions.restoreReview('p', copyId, body),
    );
    vi.spyOn(service, 'remoteBranches').mockResolvedValue({
      supported: true,
      items: [],
      limited: false,
      inspectedAt: 1,
    });
    await expect(
      asPerson(() =>
        actions.restore('p', copyId, {
          ...body,
          reviewFingerprint: review.reviewFingerprint,
          confirmation: 'RESTORE_GITHUB_STATE',
        }),
      ),
    ).rejects.toThrow('GIT_STALE');
    expect(
      (await git(['for-each-ref', 'refs/heads/mergeron-backup/'])).stdout,
    ).toBe('');
  }, 30000);

  it('returns a recovery branch instead of replaying or hiding a partial reset failure', async () => {
    const input = await prepare();
    fixtureTransport();
    const body = { ...input, target: 'github' };
    const review = await asPerson(() =>
      actions.restoreReview('p', copyId, body),
    );
    vi.spyOn(service, 'remoteBranches').mockResolvedValue({
      supported: true,
      items: [{ name: 'dev', revision: input.revision, protected: false }],
      limited: false,
      inspectedAt: 1,
    });
    const original = WorkspaceGitService.prototype.git.bind(
      service,
    ) as WorkspaceGitService['git'];
    vi.spyOn(service, 'git').mockImplementation((dir, args, ...rest) => {
      if (args[0] === 'reset' && args.includes('--hard'))
        throw new Error('private failure');
      return original(dir, args, ...rest);
    });
    const result = await asPerson(() =>
      actions.restore('p', copyId, {
        ...body,
        reviewFingerprint: review.reviewFingerprint,
        confirmation: 'RESTORE_GITHUB_STATE',
      }),
    );
    expect(result).toMatchObject({
      restored: false,
      reason: 'GIT_RESTORE_INCOMPLETE',
      backupBranch: expect.stringMatching(/^mergeron-backup\//),
    });
    expect(JSON.stringify(result)).not.toContain('private failure');
    expect((await git(['rev-parse', result.backupBranch])).stdout.trim()).toBe(
      result.backupRevision,
    );
  }, 30000);
  it('refuses a collision with an ignored file instead of cleaning or overwriting it', async () => {
    const input = await prepare();
    fixtureTransport();
    await writeFile(path.join(cwd, '.git/info/exclude'), 'remote-only.txt\n');
    await writeFile(path.join(cwd, 'remote-only.txt'), 'precious ignored\n');
    await expect(
      asPerson(() =>
        actions.restoreReview('p', copyId, { ...input, target: 'github' }),
      ),
    ).rejects.toThrow('GIT_RESTORE_COLLISION');
    expect(await readFile(path.join(cwd, 'remote-only.txt'), 'utf8')).toBe(
      'precious ignored\n',
    );
    expect(
      (await git(['for-each-ref', 'refs/heads/mergeron-backup/'])).stdout,
    ).toBe('');
  }, 30000);
  it('downloads missing objects without relying on origin or touching local work, index, HEAD or remote refs', async () => {
    const body = await prepare();
    await git(['remote', 'remove', 'origin']);
    await writeFile(path.join(cwd, 'README.md'), 'staged work\n');
    await git(['add', 'README.md']);
    await writeFile(path.join(cwd, 'README.md'), 'unstaged work\n');
    await writeFile(path.join(cwd, 'untracked.txt'), 'precious untracked\n');
    await writeFile(
      path.join(cwd, '.git/FETCH_HEAD'),
      'existing fetch record\n',
    );
    body.fingerprint = (await service.snapshot('p', copyId)).fingerprint;
    const index = await readFile(path.join(cwd, '.git/index'));
    const head = (await git(['rev-parse', 'HEAD'])).stdout;
    const calls = fixtureTransport();
    await actions.retrieveBranch('p', copyId, body);
    expect(calls()).toBe(1);
    expect((await git(['rev-parse', 'dev'])).stdout.trim()).toBe(body.revision);
    expect((await git(['show', 'dev:remote-only.txt'])).stdout).toBe(
      'remote branch content\n',
    );
    expect((await git(['rev-parse', 'HEAD'])).stdout).toBe(head);
    expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
      'main',
    );
    expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'unstaged work\n',
    );
    expect(await readFile(path.join(cwd, 'untracked.txt'), 'utf8')).toBe(
      'precious untracked\n',
    );
    expect((await git(['for-each-ref', 'refs/remotes/'])).stdout).toBe('');
    expect(await readFile(path.join(cwd, '.git/FETCH_HEAD'), 'utf8')).toBe(
      'existing fetch record\n',
    );
  });
  it('fetches and refreshes a dedicated remote ref while preserving an existing local branch and all edits', async () => {
    const body = await prepare();
    await git(['branch', 'dev']);
    const oldLocal = (await git(['rev-parse', 'dev'])).stdout.trim();
    await writeFile(path.join(cwd, 'README.md'), 'keep edits\n');
    fixtureTransport();
    await actions.retrieveBranch('p', copyId, body, undefined, true);
    expect(
      (await git(['rev-parse', 'refs/remotes/mergeron/dev'])).stdout.trim(),
    ).toBe(body.revision);
    expect((await git(['rev-parse', 'dev'])).stdout.trim()).toBe(oldLocal);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'keep edits\n',
    );
    const remote = path.join(root, 'remote');
    await writeFile(path.join(remote, 'next.txt'), 'next\n');
    await exec('git', ['-C', remote, 'add', '.']);
    await exec('git', ['-C', remote, 'commit', '-m', 'next']);
    body.revision = (
      await exec('git', ['-C', remote, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    await actions.retrieveBranch('p', copyId, body, undefined, true);
    expect(
      (await git(['rev-parse', 'refs/remotes/mergeron/dev'])).stdout.trim(),
    ).toBe(body.revision);
    expect((await git(['rev-parse', 'dev'])).stdout.trim()).toBe(oldLocal);
  });

  it('integrates a fetched tip into the active branch even when that branch already exists locally', async () => {
    const body = await prepare();
    await git(['branch', 'dev']);
    const old = (await git(['rev-parse', 'dev'])).stdout.trim();
    const calls = fixtureTransport();
    const result = await asPerson(() =>
      actions.integrateBranch('p', copyId, {
        ...body,
        confirmation: 'INTEGRATE_REMOTE_BRANCH',
      }),
    );
    expect(calls()).toBe(1);
    expect(result).toMatchObject({ branch: 'main', sha: body.revision });
    expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
      'main',
    );
    expect((await git(['rev-parse', 'dev'])).stdout.trim()).toBe(old);
    expect(await readFile(path.join(cwd, 'remote-only.txt'), 'utf8')).toBe(
      'remote branch content\n',
    );
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
  });
  it.each([false, true])(
    'integrates divergent remote history or preserves local files on conflict (%s)',
    async (conflict) => {
      const body = await prepare();
      const remote = path.join(root, 'remote');
      await writeFile(path.join(remote, 'README.md'), 'remote\n');
      await exec('git', ['-C', remote, 'add', '.']);
      await exec('git', ['-C', remote, 'commit', '-m', 'remote edit']);
      body.revision = (
        await exec('git', ['-C', remote, 'rev-parse', 'HEAD'])
      ).stdout.trim();
      await git(['config', 'user.name', 'Test']);
      await git(['config', 'user.email', 'test@example.invalid']);
      await writeFile(
        path.join(cwd, conflict ? 'README.md' : 'other.md'),
        'local\n',
      );
      await git(['add', '.']);
      await git(['commit', '-m', 'local edit']);
      const before = await service.snapshot('p', copyId);
      body.fingerprint = before.fingerprint;
      const index = await readFile(path.join(cwd, '.git/index'));
      fixtureTransport();
      const integrate = () =>
        asPerson(() =>
          actions.integrateBranch('p', copyId, {
            ...body,
            confirmation: 'INTEGRATE_REMOTE_BRANCH',
          }),
        );
      if (conflict) {
        await expect(integrate()).rejects.toThrow('GIT_LOCAL_MERGE_CONFLICT');
        expect((await service.snapshot('p', copyId)).head).toBe(before.head);
        expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
        expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
          'local\n',
        );
        expect((await service.mergeStatus('p', copyId)).mergeHead).toBeNull();
      } else {
        await integrate();
        expect((await git(['show', '-s', '--format=%P'])).stdout.trim()).toBe(
          `${before.head} ${body.revision}`,
        );
        expect((await git(['show', '-s', '--format=%ae'])).stdout.trim()).toBe(
          connectedPerson.email,
        );
        expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
          'remote\n',
        );
        expect(await readFile(path.join(cwd, 'other.md'), 'utf8')).toBe(
          'local\n',
        );
      }
    },
  );
  it('refuses dirty copies and missing confirmation before downloading and never adopts a changed state', async () => {
    const body = await prepare();
    const calls = fixtureTransport();
    await writeFile(path.join(cwd, 'untracked.txt'), 'keep\n');
    body.fingerprint = (await service.snapshot('p', copyId)).fingerprint;
    await expect(
      actions.integrateBranch('p', copyId, {
        ...body,
        confirmation: 'INTEGRATE_REMOTE_BRANCH',
      }),
    ).rejects.toThrow('GIT_WORKTREE_DIRTY');
    expect(calls()).toBe(0);
    await expect(actions.integrateBranch('p', copyId, body)).rejects.toThrow(
      'GIT_INVALID_INPUT',
    );
    await rm(path.join(cwd, 'untracked.txt'));
    body.fingerprint = (await service.snapshot('p', copyId)).fingerprint;
    const fetchBranch = actions.retrieveBranch.bind(
      actions,
    ) as WorkspaceGitActionsService['retrieveBranch'];
    vi.spyOn(actions, 'retrieveBranch').mockImplementation(async (...args) => {
      const result = await fetchBranch(...args);
      await writeFile(path.join(cwd, 'untracked.txt'), 'concurrent edit\n');
      return result;
    });
    await expect(
      actions.integrateBranch('p', copyId, {
        ...body,
        confirmation: 'INTEGRATE_REMOTE_BRANCH',
      }),
    ).rejects.toThrow('GIT_WORKTREE_DIRTY');
    expect(await readFile(path.join(cwd, 'untracked.txt'), 'utf8')).toBe(
      'concurrent edit\n',
    );
  });

  it('never overwrites an existing local branch, including one created during download', async () => {
    const body = await prepare();
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const calls = fixtureTransport(async () => {
      await git(['branch', 'dev']);
    });
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow(
      'GIT_BRANCH_EXISTS',
    );
    expect((await git(['rev-parse', 'dev'])).stdout.trim()).toBe(head);
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow(
      'GIT_BRANCH_EXISTS',
    );
    expect(calls()).toBe(1);
  });
  it('atomically refuses a branch created immediately before publishing the new ref', async () => {
    const body = await prepare();
    fixtureTransport(undefined, async () => {
      await git(['branch', 'dev']);
    });
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow();
    expect((await git(['rev-parse', 'dev'])).stdout.trim()).not.toBe(
      body.revision,
    );
  });
  it('never replaces a symbolic branch created concurrently', async () => {
    const body = await prepare();
    fixtureTransport(undefined, async () => {
      await git(['symbolic-ref', 'refs/heads/dev', 'refs/heads/main']);
    });
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow();
    expect((await git(['symbolic-ref', 'refs/heads/dev'])).stdout.trim()).toBe(
      'refs/heads/main',
    );
  });
  it('refuses a changed remote revision without creating a local branch', async () => {
    const body = await prepare();
    fixtureTransport();
    await expect(
      actions.retrieveBranch('p', copyId, {
        ...body,
        revision: '0'.repeat(40),
      }),
    ).rejects.toThrow('GIT_STALE');
    await expect(
      git(['rev-parse', '--verify', 'refs/heads/dev']),
    ).rejects.toThrow();
  });
  it('refuses stale state, changed source, missing confirmation and unsafe branch names before fetching', async () => {
    const body = await prepare();
    const calls = fixtureTransport();
    for (const override of [
      { confirmation: '' },
      { name: '--upload-pack=evil' },
      { name: 'dev\nmain' },
      { name: '../dev' },
      { revision: 'HEAD' },
    ])
      await expect(
        actions.retrieveBranch('p', copyId, { ...body, ...override }),
      ).rejects.toThrow();
    await expect(
      actions.retrieveBranch('p', copyId, { ...body, fingerprint: 'stale' }),
    ).rejects.toThrow('GIT_STALE');
    await expect(
      actions.retrieveBranch('p', copyId, {
        ...body,
        address: 'https://other.invalid/repo',
      }),
    ).rejects.toThrow('GIT_STALE');
    expect(calls()).toBe(0);
  });
  it('blocks read-only access, busy agents and incomplete Git operations', async () => {
    const body = await prepare();
    const calls = fixtureTransport();
    resources.update('p', 'remote', { accessMode: 'read_only' });
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow(
      'GIT_READ_ONLY',
    );
    writable();
    active.push('busy');
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow(
      'GIT_BUSY',
    );
    active.length = 0;
    await writeFile(path.join(cwd, '.git/MERGE_HEAD'), body.revision);
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow(
      'GIT_IN_PROGRESS',
    );
    expect(calls()).toBe(0);
  });
  it('checks copy ownership before downloading and rechecks index changes after download', async () => {
    const body = await prepare();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'owner',
        projectId: 'p',
        workspacePath: path.join(root, 'project'),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    claimAgentCopy(database.db, 'p', 'owner', copyId);
    const calls = fixtureTransport(async () => {
      await writeFile(path.join(cwd, 'README.md'), 'new staged edits\n');
      await git(['add', 'README.md']);
    });
    await expect(
      actions.retrieveBranch('p', copyId, { ...body, agentThreadId: 'other' }),
    ).rejects.toThrow('GIT_COPY_OWNED');
    expect(calls()).toBe(0);
    await expect(
      actions.retrieveBranch('p', copyId, { ...body, agentThreadId: 'owner' }),
    ).rejects.toThrow('GIT_STALE');
    await expect(
      git(['rev-parse', '--verify', 'refs/heads/dev']),
    ).rejects.toThrow();
    expect((await git(['show', ':README.md'])).stdout).toBe(
      'new staged edits\n',
    );
  });
  it('fails closed on download failure without changing refs or exposing credentials', async () => {
    const body = await prepare();
    const runGit = service.git.bind(service) as WorkspaceGitService['git'];
    vi.spyOn(service, 'git').mockImplementation(async (dir, args, ...rest) => {
      if (args.includes('fetch')) throw new Error('GIT_NETWORK_UNAVAILABLE');
      return runGit(dir, args, ...rest);
    });
    const before = await service.snapshot('p', copyId);
    await expect(actions.retrieveBranch('p', copyId, body)).rejects.toThrow(
      'GIT_NETWORK_UNAVAILABLE',
    );
    expect((await service.snapshot('p', copyId)).branches).toEqual(
      before.branches,
    );
    expect((await service.snapshot('p', copyId)).head).toBe(before.head);
  });
  it('rejects unsafe transports instead of using local SSH or credentials', async () => {
    const body = await prepare();
    const calls = fixtureTransport();
    for (const address of [
      'git@github.com:example/demo.git',
      'http://github.com/example/demo.git',
    ]) {
      resources.update('p', 'remote', { address });
      await expect(
        actions.retrieveBranch('p', copyId, { ...body, address }),
      ).rejects.toThrow('GIT_HTTPS_REQUIRED');
    }
    expect(() =>
      resources.update('p', 'remote', {
        address: 'https://user:secret@github.com/example/demo.git',
      }),
    ).toThrow('Credentials must be stored');
    expect(calls()).toBe(0);
  });
});

describe('confirmed actions', () => {
  const prInput = async () => {
    writable();
    resources.update('p', 'remote', { secret: { token: 'test-pr-token' } });
    const state = await service.snapshot('p', copyId);
    return {
      confirmation: 'CREATE_PULL_REQUEST',
      fingerprint: state.fingerprint,
      head: state.head,
      address: 'https://github.com/example/demo.git',
      base: 'develop',
      title: 'Reviewed change',
      description: 'User description',
      draft: true,
    };
  };
  it('requires write access and the copy owner before PR requests', async () => {
    const input = await prInput();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    resources.update('p', 'remote', { accessMode: 'read_only' });
    await expect(actions.createPullRequest('p', copyId, input)).rejects.toThrow(
      'GIT_READ_ONLY',
    );
    writable();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'owner',
        projectId: 'p',
        workspacePath: path.join(root, 'project'),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    claimAgentCopy(database.db, 'p', 'owner', copyId);
    await expect(
      actions.createPullRequest('p', copyId, {
        ...input,
        agentThreadId: 'other',
      }),
    ).rejects.toThrow('GIT_COPY_OWNED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses PR creation without explicit GitHub credentials before any API call', async () => {
    writable();
    const state = await service.snapshot('p', copyId);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      actions.createPullRequest('p', copyId, {
        confirmation: 'CREATE_PULL_REQUEST',
        fingerprint: state.fingerprint,
        head: state.head,
        address: 'https://github.com/example/demo.git',
        base: 'develop',
        title: 'Title',
        description: '',
        draft: false,
      }),
    ).rejects.toThrow('GIT_GITHUB_TOKEN_REQUIRED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'creates a PR for the exact published head using the fixed GitHub API (native caller: %s)',
    async (native) => {
      const input = await prInput();
      if (native) {
        database.db
          .insert(projectAgentThreads)
          .values({
            threadId: 'agent',
            projectId: 'p',
            workspacePath: cwd,
            createdAt: 1,
            updatedAt: 1,
          })
          .run();
        active = ['agent'];
      }
      const fetch = vi
        .fn()
        .mockImplementation(async (url: string, options?: RequestInit) => ({
          ok: true,
          json: async () =>
            options?.method === 'POST'
              ? { number: 12 }
              : url.includes('/branches/')
                ? {
                    commit: {
                      sha: url.endsWith('/main') ? input.head : 'a'.repeat(40),
                    },
                  }
                : [],
        }));
      vi.stubGlobal('fetch', fetch);
      await expect(
        asPerson(() =>
          actions.createPullRequest(
            'p',
            copyId,
            { ...input, ...(native ? { agentThreadId: 'agent' } : {}) },
            native ? { threadId: 'agent', assertActive: () => {} } : undefined,
          ),
        ),
      ).resolves.toEqual({
        number: 12,
        url: 'https://github.com/example/demo/pull/12',
        existing: false,
      });
      const posts = fetch.mock.calls.filter(
        ([, options]) =>
          (options as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]).toEqual([
        'https://api.github.com/repos/example/demo/pulls',
        expect.objectContaining({
          redirect: 'error',
          body: JSON.stringify({
            title: 'Reviewed change',
            body: 'User description',
            head: 'main',
            base: 'develop',
            draft: true,
            maintainer_can_modify: false,
          }),
        }),
      ]);
      expect(
        fetch.mock.calls.every(([url]) =>
          String(url).startsWith('https://api.github.com/repos/example/demo/'),
        ),
      ).toBe(true);
      expect((await service.snapshot('p', copyId)).head).toBe(input.head);
    },
  );
  it('returns an existing PR without a second write and refuses an unpushed head', async () => {
    const input = await prInput();
    const prepare = vi
      .spyOn(service, 'pullRequestPreparation')
      .mockResolvedValue({
        head: input.head,
        baseHead: 'a'.repeat(40),
        existingNumber: 42,
      });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      actions.createPullRequest('p', copyId, input),
    ).resolves.toMatchObject({ number: 42, existing: true });
    expect(fetch).not.toHaveBeenCalled();
    prepare.mockResolvedValue({
      head: '0'.repeat(40),
      baseHead: 'a'.repeat(40),
      existingNumber: null,
    });
    await expect(actions.createPullRequest('p', copyId, input)).rejects.toThrow(
      'GIT_PR_PUSH_REQUIRED',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('blocks stale sources, equal branches, active agents and uncertain PR writes without retries', async () => {
    const input = await prInput();
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error('private network diagnostic'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      actions.createPullRequest('p', copyId, {
        ...input,
        address: 'https://other.example/repo',
      }),
    ).rejects.toThrow('GIT_STALE');
    await expect(
      actions.createPullRequest('p', copyId, { ...input, base: 'main' }),
    ).rejects.toThrow('GIT_PR_SAME_BRANCH');
    await expect(
      actions.createPullRequest('p', copyId, { ...input, title: '' }),
    ).rejects.toThrow('GIT_INVALID_INPUT');
    active.push('agent');
    await expect(actions.createPullRequest('p', copyId, input)).rejects.toThrow(
      'GIT_BUSY',
    );
    active.length = 0;
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(service, 'pullRequestPreparation').mockResolvedValue({
      head: input.head,
      baseHead: 'a'.repeat(40),
      existingNumber: null,
    });
    await expect(actions.createPullRequest('p', copyId, input)).rejects.toThrow(
      'GIT_OUTCOME_UNKNOWN',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  const branchAction = async (
    action: 'switch' | 'merge' | 'delete',
    name: string,
    overrides = {},
  ) => {
    const state = await service.snapshot('p', copyId);
    return asPerson(() =>
      actions.localBranchAction('p', copyId, {
        action,
        name,
        revision: state.branches.find((b) => !b.remote && b.name === name)
          ?.revision,
        fingerprint: state.fingerprint,
        confirmation:
          action === 'delete' ? 'DELETE_LOCAL_BRANCH' : 'LOCAL_BRANCH_ACTION',
        ...overrides,
      }),
    );
  };
  it('switches existing local branches without publishing', async () => {
    writable();
    await git(['branch', 'feature']);
    await branchAction('switch', 'feature');
    expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
      'feature',
    );
    expect((await git(['branch', '-r'])).stdout).not.toContain(
      'origin/feature',
    );
  });
  it.each(['feature', 'feature=local'])(
    'deletes only the merged local branch %s without touching files, index or remote refs',
    async (name) => {
      writable();
      await git(['branch', name]);
      const state = await service.snapshot('p', copyId);
      const index = await readFile(path.join(cwd, '.git/index'));
      const remote = (await git(['rev-parse', 'refs/remotes/origin/main']))
        .stdout;
      await branchAction('delete', name);
      await expect(
        git(['rev-parse', '--verify', `refs/heads/${name}`]),
      ).rejects.toThrow();
      expect((await service.snapshot('p', copyId)).head).toBe(state.head);
      expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
      expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
        'initial\n',
      );
      expect(
        (await git(['rev-parse', 'refs/remotes/origin/main'])).stdout,
      ).toBe(remote);
    },
  );
  it('rejects the active branch and a branch checked out in another worktree', async () => {
    writable();
    await expect(branchAction('delete', 'main')).rejects.toThrow(
      'GIT_BRANCH_ACTIVE',
    );
    await git(['branch', 'feature']);
    await git(['worktree', 'add', path.join(root, 'linked'), 'feature']);
    await expect(branchAction('delete', 'feature')).rejects.toThrow(
      'GIT_BRANCH_ACTIVE',
    );
    expect((await git(['rev-parse', 'feature'])).stdout.trim()).toBeTruthy();
  });
  it('refuses unique commits even when already merged into the configured upstream', async () => {
    writable();
    await diverge();
    await git(['branch', 'upstream-copy', 'feature']);
    await git(['branch', '--set-upstream-to=upstream-copy', 'feature']);
    const state = await service.snapshot('p', copyId);
    await expect(branchAction('delete', 'feature')).rejects.toThrow(
      'GIT_BRANCH_UNMERGED',
    );
    expect((await git(['rev-parse', 'feature'])).stdout.trim()).toBe(
      state.branches.find((b) => b.name === 'feature')?.revision,
    );
    expect((await git(['config', 'branch.feature.merge'])).stdout.trim()).toBe(
      'refs/heads/upstream-copy',
    );
  });
  it('requires deletion-specific confirmation and a current pinned revision', async () => {
    writable();
    await git(['branch', 'feature']);
    await expect(
      branchAction('delete', 'feature', {
        confirmation: 'LOCAL_BRANCH_ACTION',
      }),
    ).rejects.toThrow('GIT_INVALID_INPUT');
    await expect(
      branchAction('delete', 'feature', { revision: '0'.repeat(40) }),
    ).rejects.toThrow('GIT_STALE');
    await expect(branchAction('delete', 'origin/main')).rejects.toThrow(
      'GIT_INVALID_INPUT',
    );
    expect((await git(['rev-parse', 'feature'])).stdout.trim()).toBeTruthy();
  });
  it('still refuses deletion if unique commits appear after the last inspection', async () => {
    writable();
    await diverge();
    const unique = (await git(['rev-parse', 'feature'])).stdout.trim();
    await git(['branch', 'upstream-copy', 'feature']);
    await git(['branch', '-f', 'feature', 'main']);
    await git(['branch', '--set-upstream-to=upstream-copy', 'feature']);
    const runGit: WorkspaceGitService['git'] = service.git.bind(service);
    vi.spyOn(service, 'git').mockImplementation(async (dir, args, ...rest) => {
      if (args[0] === 'branch' && args.includes('--delete'))
        await git(['update-ref', 'refs/heads/feature', unique]);
      return runGit(dir, args, ...rest);
    });
    await expect(branchAction('delete', 'feature')).rejects.toThrow();
    expect((await git(['rev-parse', 'feature'])).stdout.trim()).toBe(unique);
  });
  it('fast-forwards and treats an already merged branch as a no-op', async () => {
    writable();
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['switch', '-c', 'feature']);
    await writeFile(path.join(cwd, 'README.md'), 'new\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'advance']);
    const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['switch', 'main']);
    await branchAction('merge', 'feature');
    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(sha);
    await branchAction('merge', 'feature');
    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(sha);
  });
  it.each(['switch', 'merge'] as const)(
    'never overwrites ignored files during %s',
    async (action) => {
      writable();
      await git(['config', 'user.name', 'Test']);
      await git(['config', 'user.email', 'test@example.invalid']);
      await git(['switch', '-c', 'feature']);
      await writeFile(path.join(cwd, 'ignored.txt'), 'tracked on feature');
      await git(['add', '.']);
      await git(['commit', '-m', 'tracked file']);
      await git(['switch', 'main']);
      await writeFile(path.join(cwd, '.git/info/exclude'), 'ignored.txt\n');
      await writeFile(path.join(cwd, 'ignored.txt'), 'keep ignored');
      await expect(branchAction(action, 'feature')).rejects.toThrow();
      expect(await readFile(path.join(cwd, 'ignored.txt'), 'utf8')).toBe(
        'keep ignored',
      );
      expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
        'main',
      );
    },
  );
  it('blocks read-only copies and never invokes a custom merge driver', async () => {
    await git(['branch', 'feature']);
    await expect(branchAction('switch', 'feature')).rejects.toThrow(
      'GIT_READ_ONLY',
    );
    writable();
    await git(['branch', '-D', 'feature']);
    await diverge();
    await git(['config', 'merge.custom.driver', 'false']);
    await expect(branchAction('merge', 'feature')).rejects.toThrow(
      'GIT_CUSTOM_MERGE_DRIVER',
    );
  });
  it.each(['untracked', 'unstaged', 'staged'])(
    'preserves %s changes and blocks both actions',
    async (kind) => {
      writable();
      await git(['branch', 'feature']);
      const file = path.join(
        cwd,
        kind === 'untracked' ? 'new.txt' : 'README.md',
      );
      await writeFile(file, 'precious edits');
      if (kind === 'staged') await git(['add', 'README.md']);
      const index = await readFile(path.join(cwd, '.git/index'));
      for (const action of ['switch', 'merge'] as const)
        await expect(branchAction(action, 'feature')).rejects.toThrow(
          'GIT_WORKTREE_DIRTY',
        );
      expect(await readFile(file, 'utf8')).toBe('precious edits');
      expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
      expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
        'main',
      );
    },
  );
  const diverge = async (conflict = false) => {
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['switch', '-c', 'feature']);
    await writeFile(path.join(cwd, 'README.md'), 'feature\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'feature']);
    await git(['switch', 'main']);
    await writeFile(
      path.join(cwd, conflict ? 'README.md' : 'other.md'),
      'main\n',
    );
    await git(['add', '.']);
    await git(['commit', '-m', 'main']);
  };
  it('merges divergent branches with two parents and authenticated author', async () => {
    writable();
    await diverge();
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const source = (await git(['rev-parse', 'feature'])).stdout.trim();
    await branchAction('merge', 'feature');
    expect((await git(['show', '-s', '--format=%P'])).stdout.trim()).toBe(
      `${head} ${source}`,
    );
    expect((await git(['show', '-s', '--format=%ae'])).stdout.trim()).toBe(
      connectedPerson.email,
    );
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'feature\n',
    );
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
  });
  it('refuses conflicts without touching HEAD, index or worktree', async () => {
    writable();
    await diverge(true);
    const before = await service.snapshot('p', copyId);
    const index = await readFile(path.join(cwd, '.git/index'));
    await expect(branchAction('merge', 'feature')).rejects.toThrow(
      'GIT_LOCAL_MERGE_CONFLICT',
    );
    expect((await service.snapshot('p', copyId)).head).toBe(before.head);
    expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe('main\n');
  });
  it('blocks stale revisions, missing confirmation, active agents and unfinished operations', async () => {
    writable();
    await git(['branch', 'feature']);
    await expect(
      branchAction('switch', 'feature', { revision: '0'.repeat(40) }),
    ).rejects.toThrow('GIT_STALE');
    await expect(
      branchAction('switch', 'feature', { confirmation: '' }),
    ).rejects.toThrow('GIT_INVALID_INPUT');
    active.push('busy');
    await expect(branchAction('switch', 'feature')).rejects.toThrow('GIT_BUSY');
    active.length = 0;
    await writeFile(path.join(cwd, '.git/MERGE_HEAD'), 'unfinished');
    await expect(branchAction('switch', 'feature')).rejects.toThrow(
      'GIT_IN_PROGRESS',
    );
  });

  it('creates a local branch at a pinned starting point without switching or publishing', async () => {
    writable();
    const snapshot = await service.snapshot('p', copyId);
    await git(['branch', 'base-old', snapshot.head]);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(cwd, 'README.md'), 'newer commit\n');
    await git(['add', 'README.md']);
    await git(['commit', '-m', 'advance main']);
    const current = await service.snapshot('p', copyId);
    await writeFile(path.join(cwd, 'README.md'), 'keep local edits\n');
    await actions.createBranch('p', copyId, {
      name: 'feature/local',
      startRef: 'refs/heads/base-old',
      startRevision: snapshot.head,
      checkout: false,
      fingerprint: current.fingerprint,
      confirmation: 'CREATE_LOCAL_BRANCH',
    });
    expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
      'main',
    );
    expect((await git(['rev-parse', 'feature/local'])).stdout.trim()).toBe(
      snapshot.head,
    );
    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(current.head);
    expect(current.head).not.toBe(snapshot.head);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'keep local edits\n',
    );
    await expect(
      git(['rev-parse', '--verify', 'refs/remotes/origin/feature/local']),
    ).rejects.toThrow();
  });

  it('creates and switches only on a clean copy and keeps an existing branch intact', async () => {
    writable();
    const snapshot = await service.snapshot('p', copyId);
    const body = {
      name: 'feature/switch',
      startRef: 'refs/remotes/origin/main',
      startRevision: snapshot.head,
      checkout: true,
      fingerprint: snapshot.fingerprint,
      confirmation: 'CREATE_LOCAL_BRANCH',
    };
    await writeFile(path.join(cwd, 'untracked.txt'), 'keep');
    await expect(actions.createBranch('p', copyId, body)).rejects.toThrow(
      'GIT_WORKTREE_DIRTY',
    );
    await expect(
      git(['rev-parse', '--verify', 'refs/heads/feature/switch']),
    ).rejects.toThrow();
    await rm(path.join(cwd, 'untracked.txt'));
    await expect(
      actions.createBranch('p', copyId, body),
    ).resolves.toMatchObject({ branch: 'feature/switch', checkedOut: true });
    expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
      'feature/switch',
    );
    const updated = await service.snapshot('p', copyId);
    await expect(
      actions.createBranch('p', copyId, {
        ...body,
        fingerprint: updated.fingerprint,
      }),
    ).rejects.toThrow('GIT_BRANCH_EXISTS');
    expect((await git(['rev-parse', 'main'])).stdout.trim()).toBe(
      snapshot.head,
    );
  });

  it('rejects invalid names, stale references, readonly copies and active agents without mutations', async () => {
    const snapshot = await service.snapshot('p', copyId);
    const body = {
      name: 'feature/safe',
      startRef: 'HEAD',
      startRevision: snapshot.head,
      checkout: false,
      fingerprint: snapshot.fingerprint,
      confirmation: 'CREATE_LOCAL_BRANCH',
    };
    await expect(actions.createBranch('p', copyId, body)).rejects.toThrow(
      'GIT_READ_ONLY',
    );
    writable();
    for (const name of ['bad..name', 'bad name', '@{-1}', 'refs/heads/../bad'])
      await expect(
        actions.createBranch('p', copyId, { ...body, name }),
      ).rejects.toThrow('GIT_BRANCH_NAME_INVALID');
    await expect(
      actions.createBranch('p', copyId, {
        ...body,
        startRevision: '0'.repeat(40),
      }),
    ).rejects.toThrow('GIT_STALE');
    await expect(
      actions.createBranch('p', copyId, { ...body, fingerprint: 'stale' }),
    ).rejects.toThrow('GIT_STALE');
    active.push('agent');
    await expect(actions.createBranch('p', copyId, body)).rejects.toThrow(
      'GIT_BUSY',
    );
    expect((await git(['branch', '--show-current'])).stdout.trim()).toBe(
      'main',
    );
    await expect(
      git(['rev-parse', '--verify', 'refs/heads/feature/safe']),
    ).rejects.toThrow();
  });
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

  it('uses the connected person for author and committer, ignoring client fields and Git config', async () => {
    writable();
    const state = await staged();
    await git(['config', 'user.name', 'Forged Config']);
    await git(['config', 'user.email', 'forged-config@example.invalid']);
    await commit('p', copyId, {
      fingerprint: state.fingerprint,
      message: 'Verified identity',
      authorName: 'Forged Client',
      authorEmail: 'forged-client@example.invalid',
    });
    expect(
      (
        await git(['show', '-s', '--format=%an|%ae|%cn|%ce', 'HEAD'])
      ).stdout.trim(),
    ).toBe(
      'Reviewer|reviewer@example.invalid|Reviewer|reviewer@example.invalid',
    );
  });

  it('requires a real active person with valid profile details, even if the client supplies an author', async () => {
    writable();
    const state = await staged();
    const body = { ...identity, fingerprint: state.fingerprint };
    await expect(actions.commit('p', copyId, body)).rejects.toThrow(
      'GIT_IDENTITY_REQUIRED',
    );
    for (const person of [
      { ...connectedPerson, kind: 'service' as const },
      { ...connectedPerson, personId: null },
    ]) {
      await expect(
        asPerson(() => actions.commit('p', copyId, body), person),
      ).rejects.toThrow();
    }
    for (const profile of [
      { name: '', email: 'reviewer@example.invalid' },
      { name: 'Reviewer', email: null },
      { name: 'Reviewer', email: 'invalid' },
      { name: 'Bad\nName', email: 'reviewer@example.invalid' },
      { name: 'Reviewer', email: 'bad\0@example.invalid' },
    ]) {
      database.sqlite
        .prepare('UPDATE people SET name=?, email=? WHERE id=?')
        .run(profile.name, profile.email, 'reviewer-person');
      await expect(commit('p', copyId, body)).rejects.toThrow(
        'GIT_IDENTITY_REQUIRED',
      );
    }
    database.sqlite
      .prepare('UPDATE people SET active=0 WHERE id=?')
      .run('reviewer-person');
    await expect(
      asPerson(() => actions.commit('p', copyId, body), {
        ...connectedPerson,
        active: false,
      }),
    ).rejects.toThrow();
    expect((await service.snapshot('p', copyId)).head).toBe(state.head);
  });

  it('rejects stage, commit and push on another work agent’s reserved copy', async () => {
    writable();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'owner',
        projectId: 'p',
        workspacePath: path.join(root, 'project'),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    claimAgentCopy(database.db, 'p', 'owner', copyId);
    await writeFile(path.join(cwd, 'README.md'), 'change\n');
    const state = await service.snapshot('p', copyId);
    const wrong = {
      agentThreadId: 'another-agent',
      fingerprint: state.fingerprint,
      paths: ['README.md'],
    };
    await expect(
      actions.createBranch('p', copyId, {
        ...wrong,
        name: 'feature/forbidden',
        startRef: 'HEAD',
        startRevision: state.head,
        checkout: false,
        confirmation: 'CREATE_LOCAL_BRANCH',
      }),
    ).rejects.toThrow('GIT_COPY_OWNED');
    await expect(actions.stageReview('p', copyId, wrong)).rejects.toThrow(
      'GIT_COPY_OWNED',
    );
    await expect(
      commit('p', copyId, { ...wrong, ...identity }),
    ).rejects.toThrow('GIT_COPY_OWNED');
    await expect(
      actions.push('p', copyId, {
        ...wrong,
        address: 'https://github.com/example/demo.git',
      }),
    ).rejects.toThrow('GIT_COPY_OWNED');
    await expect(
      actions.stageReview('p', copyId, { ...wrong, agentThreadId: 'owner' }),
    ).resolves.toMatchObject({
      files: [{ path: 'README.md', text: 'change\n' }],
    });
  });

  it('prepares only selected files, commits them, and preserves other working changes', async () => {
    writable();
    await writeFile(path.join(cwd, 'README.md'), 'selected content\n');
    await writeFile(path.join(cwd, 'other.md'), 'leave this local\n');
    const state = await service.snapshot('p', copyId);
    const body = { paths: ['README.md'], fingerprint: state.fingerprint };
    const review = await actions.stageReview('p', copyId, body);
    expect(review.files[0].text).toBe('selected content\n');
    await actions.stage('p', copyId, {
      ...body,
      reviewFingerprint: review.reviewFingerprint,
    });
    expect((await git(['diff', '--cached', '--name-only'])).stdout.trim()).toBe(
      'README.md',
    );
    const prepared = await service.snapshot('p', copyId);
    await commit('p', copyId, {
      ...identity,
      fingerprint: prepared.fingerprint,
    });
    expect((await git(['show', 'HEAD:README.md'])).stdout).toBe(
      'selected content\n',
    );
    expect((await git(['show', 'HEAD:other.md'])).stdout).toBe(
      'private comparison\n',
    );
    expect(await readFile(path.join(cwd, 'other.md'), 'utf8')).toBe(
      'leave this local\n',
    );
  });

  it('performs controlled local preparation for the sole active owner without discarding files or opening UI writes', async () => {
    writable();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'owner',
        projectId: 'p',
        workspacePath: path.join(root, 'project'),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    claimAgentCopy(database.db, 'p', 'owner', copyId);
    active = ['owner'];
    const preparer = { threadId: 'owner', assertActive: vi.fn() };
    const state = await service.snapshot('p', copyId);
    await actions.createBranch(
      'p',
      copyId,
      {
        agentThreadId: 'owner',
        fingerprint: state.fingerprint,
        name: 'docs/controlled',
        startRef: 'HEAD',
        startRevision: state.head,
        checkout: true,
        confirmation: 'CREATE_LOCAL_BRANCH',
      },
      preparer,
    );
    await writeFile(path.join(cwd, 'README.md'), 'selected\n');
    await writeFile(path.join(cwd, 'other.md'), 'keep unstaged\n');
    const body = {
      agentThreadId: 'owner',
      paths: ['README.md'],
      fingerprint: (await service.snapshot('p', copyId)).fingerprint,
    };
    const review = await actions.stageReview('p', copyId, body);
    await expect(
      actions.stage('p', copyId, {
        ...body,
        reviewFingerprint: review.reviewFingerprint,
      }),
    ).rejects.toThrow('GIT_BUSY');
    await actions.stage(
      'p',
      copyId,
      { ...body, reviewFingerprint: review.reviewFingerprint },
      preparer,
    );
    const prepared = await service.snapshot('p', copyId);
    await asPerson(() =>
      actions.commit(
        'p',
        copyId,
        {
          agentThreadId: 'owner',
          fingerprint: prepared.fingerprint,
          message: 'Controlled docs update',
        },
        preparer,
      ),
    );
    expect((await git(['show', 'HEAD:README.md'])).stdout).toBe('selected\n');
    expect(await readFile(path.join(cwd, 'other.md'), 'utf8')).toBe(
      'keep unstaged\n',
    );
    expect(
      (await git(['show', '-s', '--format=%an <%ae>'])).stdout.trim(),
    ).toBe('Reviewer <reviewer@example.invalid>');
    expect(preparer.assertActive).toHaveBeenCalled();
    active.push('child');
    await expect(
      actions.unstage(
        'p',
        copyId,
        {
          ...body,
          fingerprint: (await service.snapshot('p', copyId)).fingerprint,
        },
        preparer,
      ),
    ).rejects.toThrow('GIT_BUSY');
    expect(await readFile(path.join(cwd, 'other.md'), 'utf8')).toBe(
      'keep unstaged\n',
    );
  });

  it('updates only metadata of an observed open PR belonging to the current repository and branch', async () => {
    writable();
    resources.update('p', 'remote', { secret: { token: 'unit-update-token' } });
    const state = await service.snapshot('p', copyId);
    const observed = {
      number: 271,
      title: 'Old title',
      description: 'Old body',
      descriptionLimited: false,
      updatedAt: '2026-10-30T12:00:00Z',
      state: 'open',
      draft: false,
      mergeable: true,
      head: state.head,
      branch: state.branch!,
      base: 'main',
      baseHead: state.head,
      sameRepository: true,
      url: 'https://github.com/example/demo/pull/271',
    };
    const inspect = vi
      .spyOn(service, 'pullRequest')
      .mockResolvedValue(observed);
    const updated = {
      number: 271,
      title: 'New title',
      body: 'New body',
      state: 'open',
      head: {
        sha: state.head,
        ref: state.branch,
        repo: { full_name: 'example/demo' },
      },
    };
    const transport = vi.fn(() => Promise.resolve(Response.json(updated)));
    vi.stubGlobal('fetch', transport);
    const body = {
      fingerprint: state.fingerprint,
      head: state.head,
      address: 'https://github.com/example/demo.git',
      number: 271,
      title: 'New title',
      description: 'New body',
      expectedUpdatedAt: observed.updatedAt,
    };
    await expect(
      actions.updatePullRequest('p', copyId, body),
    ).resolves.toMatchObject({ updated: true, number: 271 });
    expect(transport).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/demo/pulls/271',
      expect.objectContaining({
        method: 'PATCH',
        redirect: 'error',
        body: JSON.stringify({ title: 'New title', body: 'New body' }),
      }),
    );
    transport.mockClear();
    for (const override of [
      { sameRepository: false },
      { branch: 'someone-else' },
      { head: 'c'.repeat(40) },
      { state: 'closed' },
      { updatedAt: '2026-10-30T12:01:00Z' },
    ]) {
      inspect.mockResolvedValueOnce({ ...observed, ...override });
      await expect(
        actions.updatePullRequest('p', copyId, body),
      ).rejects.toThrow('GIT_STALE');
    }
    expect(transport).not.toHaveBeenCalled();
    for (const response of [
      Response.json({ ...updated, number: 272 }),
      Response.json({ ...updated, title: 'Different title' }),
      Response.json({ ...updated, body: 'Different body' }),
      Response.json({
        ...updated,
        head: { ...updated.head, sha: 'c'.repeat(40) },
      }),
      new Response('not JSON', { status: 200 }),
    ]) {
      transport.mockResolvedValueOnce(response);
      await expect(
        actions.updatePullRequest('p', copyId, body),
      ).rejects.toThrow('GIT_OUTCOME_UNKNOWN');
    }
    transport.mockRejectedValueOnce(new Error('connection lost'));
    await expect(actions.updatePullRequest('p', copyId, body)).rejects.toThrow(
      'GIT_OUTCOME_UNKNOWN',
    );
  });

  it('prepares, commits and creates two PRs concurrently on separate copies of the same connection', async () => {
    // Both real local clones share one configured source; GitHub responses are fixtures.
    const second = await copies.create('p', 'remote', {});
    writable();
    resources.update('p', 'remote', {
      secret: { token: 'unit-concurrent-token' },
    });
    const secondCwd = second.localPath!;
    const entries = [
      {
        id: copyId,
        dir: cwd,
        owner: 'alice',
        branch: 'feature/a',
        content: 'alice change\n',
      },
      {
        id: second.id,
        dir: secondCwd,
        owner: 'bob',
        branch: 'feature/b',
        content: 'bob change\n',
      },
    ];
    for (const entry of entries) {
      const state = await service.snapshot('p', entry.id);
      await actions.createBranch('p', entry.id, {
        name: entry.branch,
        startRef: 'HEAD',
        startRevision: state.head,
        fingerprint: state.fingerprint,
        checkout: true,
        confirmation: 'CREATE_LOCAL_BRANCH',
      });
      database.db
        .insert(projectAgentThreads)
        .values({
          threadId: entry.owner,
          projectId: 'p',
          workspacePath: path.join(root, 'project'),
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      claimAgentCopy(database.db, 'p', entry.owner, entry.id);
      await writeFile(path.join(entry.dir, 'README.md'), entry.content);
    }
    for (const entry of entries)
      gate.recordIsolation(
        entry.owner,
        agentCopyPermissions(database.db, 'p', entry.owner),
      );
    gate.recordIsolation('observer', {
      writableCopyPath: null,
      readOnlyRoots: [
        await realpath(path.join(root, 'project/sources/.external')),
      ],
    });
    active = ['alice', 'bob', 'observer'];
    const prepared = await Promise.all(
      entries.map(async (entry) => {
        const body = {
          agentThreadId: entry.owner,
          paths: ['README.md'],
          fingerprint: (await service.snapshot('p', entry.id)).fingerprint,
        };
        const review = await actions.stageReview('p', entry.id, body);
        return {
          entry,
          body: { ...body, reviewFingerprint: review.reviewFingerprint },
          actor: { threadId: entry.owner, assertActive: vi.fn() },
        };
      }),
    );
    let allowFirst!: () => void, firstEntered!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      allowFirst = resolve;
    });
    const original = service.git.bind(service) as WorkspaceGitService['git'];
    const physicalCwd = await realpath(cwd);
    const spy = vi
      .spyOn(service, 'git')
      .mockImplementation(
        async (...args: Parameters<WorkspaceGitService['git']>) => {
          if (args[0] === physicalCwd && args[1][0] === 'hash-object') {
            firstEntered();
            await releaseFirst;
          }
          return original(...args);
        },
      );
    const first = actions.stage(
      'p',
      copyId,
      prepared[0].body,
      prepared[0].actor,
    );
    await firstWaiting;
    try {
      await actions.stage('p', second.id, prepared[1].body, prepared[1].actor);
      expect(
        (await exec('git', ['-C', secondCwd, 'show', ':README.md'])).stdout,
      ).toBe('bob change\n');
      expect(
        (await exec('git', ['-C', cwd, 'show', ':README.md'])).stdout,
      ).toBe('initial\n');
    } finally {
      allowFirst();
      await first;
      spy.mockRestore();
    }
    await Promise.all(
      prepared.map(async ({ entry, actor }) =>
        commit(
          'p',
          entry.id,
          {
            agentThreadId: entry.owner,
            fingerprint: (await service.stagedDiff('p', entry.id)).fingerprint,
            message: entry.content.trim(),
          },
          actor,
        ),
      ),
    );
    for (const entry of entries)
      expect(
        (await exec('git', ['-C', entry.dir, 'show', 'HEAD:README.md'])).stdout,
      ).toBe(entry.content);
    const states = await Promise.all(
      entries.map((entry) => service.snapshot('p', entry.id)),
    );
    vi.spyOn(service, 'pullRequestPreparation').mockImplementation(
      async (_p, _r, branch) => ({
        head: states[branch === 'feature/a' ? 0 : 1].head,
        baseHead: 'a'.repeat(40),
        existingNumber: null,
      }),
    );
    let releasePost!: () => void, postEntered!: () => void;
    const posting = new Promise<void>((resolve) => {
      postEntered = resolve;
    });
    const finishPost = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const fetchFixture = vi.fn(async (_url: string, options?: RequestInit) => {
      if (typeof options?.body !== 'string')
        throw new Error('Expected a JSON request body');
      const data = JSON.parse(options.body) as { head: string };
      if (data.head === 'feature/a') {
        postEntered();
        await finishPost;
      }
      return {
        ok: true,
        json: async () => ({ number: data.head === 'feature/a' ? 31 : 32 }),
      };
    });
    vi.stubGlobal('fetch', fetchFixture);
    const publish = (index: number) =>
      actions.createPullRequest(
        'p',
        entries[index].id,
        {
          agentThreadId: entries[index].owner,
          fingerprint: states[index].fingerprint,
          head: states[index].head,
          address: 'https://github.com/example/demo.git',
          base: 'main',
          title: entries[index].content.trim(),
          description: '',
          draft: false,
          confirmation: 'CREATE_PULL_REQUEST',
        },
        prepared[index].actor,
      );
    const firstPR = publish(0);
    await posting;
    try {
      await expect(publish(1)).resolves.toMatchObject({
        number: 32,
        existing: false,
      });
    } finally {
      releasePost();
    }
    await expect(firstPR).resolves.toMatchObject({
      number: 31,
      existing: false,
    });
    expect(fetchFixture).toHaveBeenCalledTimes(2);
  }, 15000);

  it('unstages selected changes without changing their file or other staged entries', async () => {
    writable();
    await writeFile(path.join(cwd, 'README.md'), 'keep me\n');
    await writeFile(path.join(cwd, 'other.md'), 'keep staged\n');
    await git(['add', '.']);
    const state = await service.snapshot('p', copyId);
    await actions.unstage('p', copyId, {
      paths: ['README.md'],
      fingerprint: state.fingerprint,
    });
    expect((await git(['diff', '--cached', '--name-only'])).stdout.trim()).toBe(
      'other.md',
    );
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'keep me\n',
    );
  });

  it('rejects an edited file after review, and does not change the index', async () => {
    writable();
    await writeFile(path.join(cwd, 'README.md'), 'reviewed\n');
    const state = await service.snapshot('p', copyId);
    const body = { paths: ['README.md'], fingerprint: state.fingerprint };
    const review = await actions.stageReview('p', copyId, body);
    const index = await readFile(path.join(cwd, '.git/index'));
    await writeFile(path.join(cwd, 'README.md'), 'later edit\n');
    await expect(
      actions.stage('p', copyId, {
        ...body,
        reviewFingerprint: review.reviewFingerprint,
      }),
    ).rejects.toThrow('GIT_STALE');
    expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
  });

  it('prepares literal filenames, additions and deletions without executing clean filters', async () => {
    writable();
    const marker = path.join(root, 'filter-ran');
    await git(['config', 'filter.hostile.clean', `touch '${marker}'`]);
    await writeFile(
      path.join(cwd, '.gitattributes'),
      '*.txt filter=hostile\nother.md filter=hostile\n',
    );
    await writeFile(path.join(cwd, 'other.md'), 'tracked raw change\n');
    await writeFile(path.join(cwd, '[a].txt'), 'raw content\n');
    await writeFile(path.join(cwd, 'a.txt'), 'do not prepare\n');
    await rm(path.join(cwd, 'README.md'));
    const state = await service.snapshot('p', copyId);
    const body = {
      paths: ['[a].txt', 'README.md'],
      fingerprint: state.fingerprint,
    };
    const review = await actions.stageReview('p', copyId, body);
    await actions.stage('p', copyId, {
      ...body,
      reviewFingerprint: review.reviewFingerprint,
    });
    expect((await git(['show', ':[a].txt'])).stdout).toBe('raw content\n');
    expect((await git(['diff', '--cached', '--name-status'])).stdout).toContain(
      'D\tREADME.md',
    );
    expect(
      (await git(['diff', '--cached', '--name-only'])).stdout,
    ).not.toContain('a.txt');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('does not replace or delete another process index lock', async () => {
    writable();
    await writeFile(path.join(cwd, 'README.md'), 'change\n');
    const state = await service.snapshot('p', copyId);
    const body = { paths: ['README.md'], fingerprint: state.fingerprint };
    const review = await actions.stageReview('p', copyId, body);
    await writeFile(path.join(cwd, '.git/index.lock'), 'other process');
    await expect(
      actions.stage('p', copyId, {
        ...body,
        reviewFingerprint: review.reviewFingerprint,
      }),
    ).rejects.toThrow('GIT_BUSY');
    expect(await readFile(path.join(cwd, '.git/index.lock'), 'utf8')).toBe(
      'other process',
    );
  });

  it('refuses symlink contents and blocks preparation while an agent is running', async () => {
    writable();
    await symlink(
      path.join(root, 'remote/other.md'),
      path.join(cwd, 'link.md'),
    );
    const state = await service.snapshot('p', copyId);
    await expect(
      actions.stageReview('p', copyId, {
        paths: ['link.md'],
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_FILE_UNSAFE');
    await writeFile(path.join(cwd, 'README.md'), 'change\n');
    const next = await service.snapshot('p', copyId);
    const body = { paths: ['README.md'], fingerprint: next.fingerprint };
    const review = await actions.stageReview('p', copyId, body);
    active = ['running-agent'];
    await expect(
      actions.stage('p', copyId, {
        ...body,
        reviewFingerprint: review.reviewFingerprint,
      }),
    ).rejects.toThrow('GIT_BUSY');
  });

  it('commits the frozen reviewed index and preserves unstaged changes and the real index', async () => {
    writable();
    const state = await staged();
    await writeFile(path.join(cwd, 'README.md'), 'unstaged\n');
    const index = await readFile(path.join(cwd, '.git/index'));
    const preview = await service.stagedDiff('p', copyId);
    expect(preview.diff).toContain('+staged');
    expect(preview.diff).not.toContain('+unstaged');
    const filePreview = await service.stagedDiff('p', copyId, 'README.md');
    expect(filePreview.diff).toContain('+staged');
    expect(filePreview.diff).not.toContain('+unstaged');
    await expect(
      service.stagedDiff('p', copyId, '../README.md'),
    ).rejects.toThrow('Invalid staged Git file');
    await expect(service.stagedDiff('p', copyId, ':(glob)*')).rejects.toThrow(
      'Invalid staged Git file',
    );
    expect(preview.fingerprint).toBe(state.fingerprint);
    const result = await commit('p', copyId, {
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
  it('blocks writes when only the normalized local copy is read-only', async () => {
    writable();
    const state = await staged();
    database.sqlite
      .prepare(
        "UPDATE project_locations SET access_mode='read_only' WHERE local_workspace_id=?",
      )
      .run(copies.list('p')[0].localWorkspaceId);
    expect(copies.list('p')[0].accessMode).toBe('read_only');
    await expect(
      commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_READ_ONLY');
    expect((await service.snapshot('p', copyId)).head).toBe(state.head);
  });

  it('blocks stale index, read-only resource, busy agent and empty commits', async () => {
    let state = await staged();
    await expect(
      commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_READ_ONLY');
    writable();
    await git(['reset', 'HEAD', '--', 'README.md']);
    await expect(
      commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_STALE');
    state = await service.snapshot('p', copyId);
    await expect(
      commit('p', copyId, {
        ...identity,
        fingerprint: state.fingerprint,
      }),
    ).rejects.toThrow('GIT_NOTHING_STAGED');
    active = ['running-agent'];
    await expect(
      commit('p', copyId, {
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
    await commit('p', copyId, {
      ...identity,
      fingerprint: state.fingerprint,
    });
    await expect(readFile(marker)).rejects.toThrow();
  });
  it.each([false, true])(
    'pushes only the reviewed SHA with isolated config and no force (native caller: %s)',
    async (native) => {
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
            expect(env?.MERGERON_GIT_TOKEN).toBe('test-password');
            expect(env?.GIT_ASKPASS).toBeUndefined();
            expect(args).toContain(`credential.helper=${gitCredentialHelper}`);
            expect(args.join(' ')).not.toContain('test-password');
            expect(args).toContain('http.followRedirects=false');
            expect(args).toContain('credential.helper=');
            return '';
          }
          return original(directory, args, env, timeout);
        },
      );
      if (native) {
        database.db
          .insert(projectAgentThreads)
          .values({
            threadId: 'agent',
            projectId: 'p',
            workspacePath: cwd,
            createdAt: 1,
            updatedAt: 1,
          })
          .run();
        active = ['agent'];
      }
      const index = await readFile(path.join(cwd, '.git/index'));
      const assertActive = vi.fn();
      await asPerson(() =>
        actions.push(
          'p',
          copyId,
          {
            fingerprint: state.fingerprint,
            address: 'https://github.com/example/demo.git',
            ...(native ? { agentThreadId: 'agent' } : {}),
          },
          native ? { threadId: 'agent', assertActive } : undefined,
        ),
      );
      expect(pushed).toHaveLength(1);
      expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
      expect((await service.snapshot('p', copyId)).head).toBe(state.head);
      if (native) expect(assertActive).toHaveBeenCalledTimes(3);
    },
  );
  it('requires explicit connection credentials before attempting a push', async () => {
    writable();
    resources.update('p', 'remote', {
      address: 'https://github.com/example/demo.git',
    });
    const state = await service.snapshot('p', copyId);
    await expect(
      actions.push('p', copyId, {
        fingerprint: state.fingerprint,
        address: 'https://github.com/example/demo.git',
      }),
    ).rejects.toThrow('GIT_AUTH_REQUIRED');
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

describe('agent merge conflict workflow', () => {
  async function divergent(conflict = true) {
    resources.update('p', 'remote', {
      accessMode: 'read_write',
      address: 'https://github.com/example/demo.git',
    });
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await git(['switch', '-c', 'topic']);
    await writeFile(path.join(cwd, 'README.md'), 'topic\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'topic']);
    const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['switch', 'main']);
    await writeFile(
      path.join(cwd, conflict ? 'README.md' : 'other.txt'),
      'main\n',
    );
    await git(['add', '.']);
    await git(['commit', '-m', 'main']);
    const before = await service.snapshot('p', copyId);
    // The merge must obtain the authenticated identity instead of repository config.
    await git(['config', '--unset', 'user.name']);
    await git(['config', '--unset', 'user.email']);
    return { before, revision };
  }
  const start = async (revision: string) =>
    asPerson(async () =>
      actions.startMerge('p', copyId, {
        revision,
        fingerprint: (await service.snapshot('p', copyId)).fingerprint,
      }),
    );
  it('returns real conflicts, stages reviewed resolutions and commits the frozen result with both parents', async () => {
    const { before, revision } = await divergent();
    const pending = await start(revision);
    expect(pending.head).toBe(before.head);
    expect(pending.mergeHead).toBe(revision);
    expect(pending.conflicts).toHaveLength(3);
    const conflict = await service.conflictFile('p', copyId, 'README.md');
    expect(conflict.stages.map((entry) => entry.text)).toEqual([
      'initial\n',
      'main\n',
      'topic\n',
    ]);
    await expect(
      service.conflictFile('p', copyId, '../elsewhere'),
    ).rejects.toThrow('GIT_STALE');
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toContain(
      '<<<<<<<',
    );
    await expect(
      commit('p', copyId, {
        fingerprint: pending.fingerprint,
        mergeRevision: revision,
        message: 'Resolve',
      }),
    ).rejects.toThrow('GIT_MERGE_UNRESOLVED');
    await writeFile(path.join(cwd, 'README.md'), 'resolved\n');
    const body = { fingerprint: pending.fingerprint, paths: ['README.md'] };
    const review = await actions.stageReview('p', copyId, body);
    await actions.stage('p', copyId, {
      ...body,
      reviewFingerprint: review.reviewFingerprint,
    });
    const staged = await service.stagedDiff('p', copyId);
    expect(staged.diff).toContain('+resolved');
    await writeFile(path.join(cwd, 'README.md'), 'unstaged after review\n');
    await commit('p', copyId, {
      fingerprint: staged.fingerprint,
      mergeRevision: revision,
      message: 'Resolve',
    });
    expect((await git(['show', '-s', '--format=%P'])).stdout.trim()).toBe(
      `${before.head} ${revision}`,
    );
    expect((await git(['show', '-s', '--format=%ae'])).stdout.trim()).toBe(
      connectedPerson.email,
    );
    expect((await git(['show', 'HEAD:README.md'])).stdout).toBe('resolved\n');
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'unstaged after review\n',
    );
    expect((await service.mergeStatus('p', copyId)).mergeHead).toBeNull();
  });
  it('leaves a clean merge pending review', async () => {
    const { revision } = await divergent(false);
    const pending = await start(revision);
    expect(pending.mergeHead).toBe(revision);
    expect(pending.conflicts).toEqual([]);
    const staged = await service.stagedDiff('p', copyId);
    await commit('p', copyId, {
      fingerprint: staged.fingerprint,
      mergeRevision: revision,
      message: 'Merge topic',
    });
    expect((await service.mergeStatus('p', copyId)).mergeHead).toBeNull();
  });
  it('aborts only the observed merge, restores the pre-merge state and keeps new untracked files', async () => {
    const { before, revision } = await divergent();
    const pending = await start(revision);
    await expect(
      actions.abortMerge('p', copyId, {
        fingerprint: pending.fingerprint,
        revision: before.head,
      }),
    ).rejects.toThrow('GIT_STALE');
    await writeFile(path.join(cwd, 'untracked.txt'), 'keep\n');
    await actions.abortMerge('p', copyId, {
      fingerprint: pending.fingerprint,
      revision,
    });
    const after = await service.mergeStatus('p', copyId);
    expect(after.head).toBe(before.head);
    expect(after.mergeHead).toBeNull();
    expect(after.conflicts).toEqual([]);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe('main\n');
    expect(await readFile(path.join(cwd, 'untracked.txt'), 'utf8')).toBe(
      'keep\n',
    );
  });
  it('treats an already integrated revision as a no-op and never overwrites ignored files', async () => {
    const { before, revision } = await divergent(false);
    const noop = await start(before.head);
    expect(noop.mergeHead).toBeNull();
    expect(noop.head).toBe(before.head);
    // topic has README.md, so test an ignored path added on a separate branch.
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await git(['switch', '-c', 'ignored-source', revision]);
    await writeFile(path.join(cwd, 'ignored.txt'), 'incoming\n');
    await git(['add', 'ignored.txt']);
    await git(['commit', '-m', 'incoming ignored name']);
    const target = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['switch', 'main']);
    await writeFile(path.join(cwd, '.git/info/exclude'), 'ignored.txt\n');
    await writeFile(path.join(cwd, 'ignored.txt'), 'precious ignored\n');
    await expect(start(target)).rejects.toThrow();
    expect(await readFile(path.join(cwd, 'ignored.txt'), 'utf8')).toBe(
      'precious ignored\n',
    );
    expect((await service.snapshot('p', copyId)).head).toBe(before.head);
  });
  it('rejects dirty starts, custom drivers, stale fingerprints, and other sequencers without losing work', async () => {
    const { before, revision } = await divergent();
    await writeFile(path.join(cwd, 'README.md'), 'precious\n');
    await expect(start(revision)).rejects.toThrow('GIT_WORKTREE_DIRTY');
    await writeFile(path.join(cwd, 'README.md'), 'main\n');
    await git(['config', 'merge.custom.driver', 'touch SHOULD_NOT_RUN']);
    await expect(start(revision)).rejects.toThrow('GIT_CUSTOM_MERGE_DRIVER');
    await git(['config', '--unset', 'merge.custom.driver']);
    await expect(
      asPerson(() =>
        actions.startMerge('p', copyId, {
          revision,
          fingerprint: '0'.repeat(64),
        }),
      ),
    ).rejects.toThrow('GIT_STALE');
    await writeFile(path.join(cwd, '.git/CHERRY_PICK_HEAD'), revision);
    await expect(start(revision)).rejects.toThrow('GIT_IN_PROGRESS');
    expect((await service.snapshot('p', copyId)).head).toBe(before.head);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe('main\n');
  });
});

describe('confirmed file restoration', () => {
  beforeEach(() =>
    resources.update('p', 'remote', {
      accessMode: 'read_write',
      address: 'https://github.com/example/demo.git',
    }),
  );
  const reviewFiles = async (paths = ['README.md']) => {
    const state = await service.snapshot('p', copyId);
    const body = { target: 'head', paths, fingerprint: state.fingerprint };
    const review = await asPerson(() =>
      actions.restoreReview('p', copyId, body),
    );
    return {
      ...body,
      reviewFingerprint: review.reviewFingerprint,
      confirmation: 'RESTORE_LOCAL_FILES',
    };
  };
  it('allows the owning active agent through the authenticated gate but refuses another owner', async () => {
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'restore-agent',
        projectId: 'p',
        workspacePath: cwd,
        title: 'Restore',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    claimAgentCopy(database.db, 'p', 'restore-agent', copyId);
    await writeFile(path.join(cwd, 'README.md'), 'agent requested undo\n');
    active = ['restore-agent'];
    const state = await service.snapshot('p', copyId);
    const body = {
      target: 'head',
      paths: ['README.md'],
      fingerprint: state.fingerprint,
      agentThreadId: 'restore-agent',
    };
    const capability = { threadId: 'restore-agent', assertActive: vi.fn() };
    const review = await asPerson(() =>
      actions.restoreReview('p', copyId, body, capability),
    );
    const input = {
      ...body,
      reviewFingerprint: review.reviewFingerprint,
      confirmation: 'RESTORE_LOCAL_FILES',
    };
    await expect(
      asPerson(() =>
        actions.restore(
          'p',
          copyId,
          { ...input, agentThreadId: 'another-agent' },
          capability,
        ),
      ),
    ).rejects.toThrow('GIT_COPY_OWNED');
    const result = await asPerson(() =>
      actions.restore('p', copyId, input, capability),
    );
    expect(result.restored).toBe(true);
    expect(capability.assertActive).toHaveBeenCalled();
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'initial\n',
    );
  }, 30000);
  it('never starts replacement if a durable recovery branch cannot be created', async () => {
    await writeFile(path.join(cwd, 'README.md'), 'must survive\n');
    const input = await reviewFiles();
    const original = service.git.bind(service) as WorkspaceGitService['git'];
    vi.spyOn(service, 'git').mockImplementation((dir, args, ...rest) => {
      if (args[0] === 'update-ref') throw new Error('private disk failure');
      return original(dir, args, ...rest);
    });
    await expect(
      asPerson(() => actions.restore('p', copyId, input)),
    ).rejects.toThrow('GIT_RESTORE_BACKUP_FAILED');
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'must survive\n',
    );
  }, 30000);
  it('restores a partly staged file to HEAD, preserves other edits, and backs up both raw working bytes and staged content', async () => {
    await git(['config', 'commit.gpgsign', 'true']);
    await git(['config', 'gpg.program', '/nonexistent-do-not-execute']);
    await writeFile(path.join(cwd, 'README.md'), 'prepared\n');
    await git(['add', 'README.md']);
    const raw = Buffer.from([0, 255, 1, 13, 10]);
    await writeFile(path.join(cwd, 'README.md'), raw);
    const expected = (
      await git(['hash-object', '--no-filters', 'README.md'])
    ).stdout.trim();
    await writeFile(path.join(cwd, 'other.md'), 'keep other work\n');
    const input = await reviewFiles();
    const before = await service.snapshot('p', copyId);
    const result = await asPerson(() => actions.restore('p', copyId, input));
    expect(result.restored).toBe(true);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'initial\n',
    );
    expect(await readFile(path.join(cwd, 'other.md'), 'utf8')).toBe(
      'keep other work\n',
    );
    expect((await service.snapshot('p', copyId)).head).toBe(before.head);
    expect(
      (
        await git(['rev-parse', `${result.backupBranch}:README.md`])
      ).stdout.trim(),
    ).toBe(expected);
    expect(
      (await git(['show', `${result.backupBranch}^2:README.md`])).stdout,
    ).toBe('prepared\n');
    expect((await service.snapshot('p', copyId)).changes).toEqual([
      { path: 'other.md', status: ' M' },
    ]);
  }, 30000);
  it('removes a staged addition absent from HEAD only after preview and keeps its bytes in recovery', async () => {
    await writeFile(path.join(cwd, 'new.txt'), 'recover me\n');
    await git(['add', 'new.txt']);
    const result = await asPerson(async () =>
      actions.restore('p', copyId, await reviewFiles(['new.txt'])),
    );
    expect(result.restored).toBe(true);
    await expect(readFile(path.join(cwd, 'new.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await git(['show', `${result.backupBranch}:new.txt`])).stdout).toBe(
      'recover me\n',
    );
  }, 30000);
  it('refuses stale working bytes even though HEAD and index did not change', async () => {
    await writeFile(path.join(cwd, 'README.md'), 'reviewed\n');
    const input = await reviewFiles();
    await writeFile(path.join(cwd, 'README.md'), 'newer precious edit\n');
    await expect(
      asPerson(() => actions.restore('p', copyId, input)),
    ).rejects.toThrow('GIT_STALE');
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe(
      'newer precious edit\n',
    );
    expect(
      (await git(['for-each-ref', 'refs/heads/mergeron-backup/'])).stdout,
    ).toBe('');
  });
  it('refuses missing confirmation, read-only copies, busy agents and symlinks without overwriting anything', async () => {
    await writeFile(path.join(cwd, 'README.md'), 'keep\n');
    const input = await reviewFiles();
    await expect(
      asPerson(() =>
        actions.restore('p', copyId, { ...input, confirmation: undefined }),
      ),
    ).rejects.toThrow('GIT_INVALID_INPUT');
    resources.update('p', 'remote', { accessMode: 'read_only' });
    await expect(
      asPerson(() => actions.restore('p', copyId, input)),
    ).rejects.toThrow('GIT_READ_ONLY');
    resources.update('p', 'remote', { accessMode: 'read_write' });
    active = ['other-agent'];
    await expect(
      asPerson(() => actions.restore('p', copyId, input)),
    ).rejects.toThrow('GIT_BUSY');
    active = [];
    await rm(path.join(cwd, 'README.md'));
    await symlink(
      path.join(root, 'remote/README.md'),
      path.join(cwd, 'README.md'),
    );
    await expect(
      asPerson(() => actions.restoreReview('p', copyId, input)),
    ).rejects.toThrow('GIT_RESTORE_UNSAFE');
    expect(await readFile(path.join(root, 'remote/README.md'), 'utf8')).toBe(
      'initial\n',
    );
  });
});

describe('retargeting existing GitHub pull requests', () => {
  const prepare = async () => {
    resources.update('p', 'remote', {
      accessMode: 'read_write',
      address: 'https://github.com/example/demo.git',
      secret: { token: 'retarget-unit-token' },
    });
    const state = await service.snapshot('p', copyId);
    const input = {
      confirmation: 'RETARGET_PULL_REQUEST',
      fingerprint: state.fingerprint,
      head: state.head,
      address: 'https://github.com/example/demo.git',
      number: 267,
      base: 'main',
      expectedBase: 'feature/previous',
      expectedPullRequestHead: 'c'.repeat(40),
    };
    const pr = {
      number: 267,
      state: 'open',
      merged: false,
      head: {
        ref: 'feature/proposal',
        sha: input.expectedPullRequestHead,
        repo: { full_name: 'example/demo' },
      },
      base: { ref: input.expectedBase, repo: { full_name: 'example/demo' } },
    };
    const fetch = vi.fn((_url: unknown, options?: RequestInit) =>
      Promise.resolve(
        Response.json(
          options?.method === 'PATCH'
            ? { ...pr, base: { ...pr.base, ref: input.base } }
            : pr,
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    return { input, pr, fetch, state };
  };
  it('changes only the requested base on the fixed API and leaves the local copy unchanged', async () => {
    const { input, fetch, state } = await prepare();
    const result = await asPerson(() =>
      actions.retargetPullRequest('p', copyId, input),
    );
    expect(result).toEqual({
      number: 267,
      url: 'https://github.com/example/demo/pull/267',
      base: 'main',
      head: input.expectedPullRequestHead,
      unchanged: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/example/demo/pulls/267',
      expect.objectContaining({
        method: 'PATCH',
        redirect: 'error',
        body: JSON.stringify({ base: 'main' }),
      }),
    );
    expect(await service.snapshot('p', copyId)).toMatchObject({
      head: state.head,
      fingerprint: state.fingerprint,
    });
    expect(JSON.stringify(result)).not.toContain('retarget-unit-token');
  });
  it('retargets for an isolated active owner while locking the PR rather than the unrelated local branch', async () => {
    const { input, fetch, state } = await prepare();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: 'owner',
        projectId: 'p',
        workspacePath: path.join(root, 'project'),
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    claimAgentCopy(database.db, 'p', 'owner', copyId);
    const permissions = agentCopyPermissions(database.db, 'p', 'owner');
    gate.recordIsolation('owner', permissions);
    gate.recordIsolation('observer', {
      writableCopyPath: null,
      readOnlyRoots: permissions.readOnlyRoots,
    });
    active = ['owner', 'observer'];
    const publication = vi.spyOn(gate, 'publishFromAgent');
    const assertActive = vi.fn();
    await expect(
      asPerson(() =>
        actions.retargetPullRequest(
          'p',
          copyId,
          { ...input, agentThreadId: 'owner' },
          { threadId: 'owner', assertActive },
        ),
      ),
    ).resolves.toMatchObject({ number: input.number, base: 'main' });
    expect(publication).toHaveBeenCalledWith('owner', expect.any(Function), {
      copyPath: await realpath(cwd),
      remoteRef: JSON.stringify([input.address, 'pull_request', input.number]),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(assertActive).toHaveBeenCalledTimes(3);
    expect(await service.snapshot('p', copyId)).toMatchObject({
      head: state.head,
      fingerprint: state.fingerprint,
    });
  });
  it.each([
    'head',
    'base',
    'closed',
    'merged',
    'fork',
    'foreign',
    'number',
  ] as const)(
    'refuses changed remote state (%s) before any PATCH',
    async (change) => {
      const { input, pr, fetch } = await prepare();
      if (change === 'head') pr.head.sha = 'd'.repeat(40);
      if (change === 'base') pr.base.ref = 'changed';
      if (change === 'closed') pr.state = 'closed';
      if (change === 'merged') pr.merged = true;
      if (change === 'fork') pr.head.repo.full_name = 'another/repo';
      if (change === 'foreign') pr.base.repo.full_name = 'another/repo';
      if (change === 'number') pr.number = 268;
      await expect(
        asPerson(() => actions.retargetPullRequest('p', copyId, input)),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('accepts an already correct target without a write', async () => {
    const { input, pr, fetch } = await prepare();
    pr.base.ref = 'main';
    expect(
      await asPerson(() =>
        actions.retargetPullRequest('p', copyId, {
          ...input,
          expectedBase: 'main',
        }),
      ),
    ).toMatchObject({ unchanged: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('blocks revoked credentials or changed local state between inspection and PATCH', async () => {
    const { input, pr, fetch } = await prepare();
    fetch.mockImplementationOnce(async () => {
      resources.update('p', 'remote', { secret: { token: 'rotated' } });
      return Response.json(pr);
    });
    await expect(
      asPerson(() => actions.retargetPullRequest('p', copyId, input)),
    ).rejects.toThrow('GIT_STALE');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['network', 'server', 'invalid', 'wrong-base', 'rejected'] as const)(
    'does not retry an uncertain or rejected PATCH (%s)',
    async (failure) => {
      const { input, pr, fetch } = await prepare();
      fetch.mockImplementationOnce(async () => Response.json(pr));
      fetch.mockImplementationOnce(async () => {
        if (failure === 'network') throw Error('private diagnostic');
        if (failure === 'server') return new Response('', { status: 503 });
        if (failure === 'invalid')
          return new Response('not JSON', { status: 200 });
        if (failure === 'rejected') return new Response('', { status: 422 });
        return Response.json(pr);
      });
      await expect(
        asPerson(() => actions.retargetPullRequest('p', copyId, input)),
      ).rejects.toThrow(
        failure === 'rejected'
          ? 'GIT_PR_RETARGET_FAILED'
          : 'GIT_OUTCOME_UNKNOWN',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('refuses invalid branches, same-branch targets, read-only sources and missing tokens', async () => {
    const { input, pr, fetch } = await prepare();
    await expect(
      asPerson(() =>
        actions.retargetPullRequest('p', copyId, {
          ...input,
          base: 'invalid branch',
        }),
      ),
    ).rejects.toThrow('GIT_INVALID_INPUT');
    await expect(
      asPerson(() =>
        actions.retargetPullRequest('p', copyId, {
          ...input,
          base: pr.head.ref,
        }),
      ),
    ).rejects.toThrow('GIT_PR_SAME_BRANCH');
    resources.update('p', 'remote', { accessMode: 'read_only' });
    await expect(
      asPerson(() => actions.retargetPullRequest('p', copyId, input)),
    ).rejects.toThrow('GIT_READ_ONLY');
    resources.update('p', 'remote', { accessMode: 'read_write', secret: null });
    await expect(
      asPerson(() => actions.retargetPullRequest('p', copyId, input)),
    ).rejects.toThrow('GIT_GITHUB_TOKEN_REQUIRED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
