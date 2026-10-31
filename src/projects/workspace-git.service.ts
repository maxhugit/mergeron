import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import {
  lstat,
  realpath,
  readFile,
  mkdtemp,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';

export interface GitChange {
  path: string;
  originalPath?: string;
  status: string;
}

/** Inspection of registered copies; the command runner is server-only, never a route. */
@Injectable()
export class WorkspaceGitService {
  constructor(
    private readonly copies: WorkspaceCopiesService,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async directory(projectId: string, copyId: string) {
    const copy = this.copies.list(projectId).find((item) => item.id === copyId);
    if (!copy) throw new NotFoundException('Git working copy not found');
    if (
      copy.state !== 'ready' ||
      !copy.sourceEnabled ||
      copy.sourceType !== 'git' ||
      !copy.localPath
    )
      throw new ConflictException('Git working copy is unavailable');
    const cwd = await realpath(copy.localPath).catch(() => null);
    const rootEntry = await lstat(copy.localPath).catch(() => null);
    // Copies are independent clones, not arbitrary .git files pointing elsewhere.
    const gitPath = cwd && path.join(cwd, '.git');
    const git = gitPath && (await lstat(gitPath).catch(() => null));
    if (
      !cwd ||
      !rootEntry?.isDirectory() ||
      rootEntry.isSymbolicLink() ||
      !gitPath ||
      !git ||
      !git.isDirectory() ||
      git.isSymbolicLink()
    )
      throw new ConflictException(
        'Git working copy has moved or its metadata is unavailable',
      );
    for (const name of ['commondir', 'objects/info/alternates']) {
      if (await lstat(path.join(gitPath, name)).catch(() => null))
        throw new ConflictException('External Git metadata is not supported');
    }
    for (const name of ['objects', 'index', 'config', 'HEAD']) {
      const target = path.join(gitPath, name);
      const entry = await lstat(target).catch(() => null);
      if (
        entry &&
        (name === 'objects' ? !entry.isDirectory() : !entry.isFile())
      )
        throw new ConflictException('External Git metadata is not supported');
      if (name === 'index' && entry && entry.size > 32 * 1024 * 1024)
        throw new ConflictException('Git index exceeds its inspection limit');
      if (
        entry?.isSymbolicLink() ||
        (entry && !(await realpath(target)).startsWith(`${gitPath}${path.sep}`))
      )
        throw new ConflictException('External Git metadata is not supported');
    }
    return cwd;
  }

  async snapshot(projectId: string, copyId: string) {
    const cwd = await this.directory(projectId, copyId);
    const [branch, head, status, refs] = await Promise.all([
      this.git(cwd, ['branch', '--show-current']),
      this.git(
        cwd,
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        {},
        15000,
        [0, 1],
      ),
      this.git(cwd, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=all',
      ]),
      this.git(cwd, [
        'for-each-ref',
        '--count=500',
        '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)',
        'refs/heads/',
        'refs/remotes/',
      ]),
    ]);
    const branches = refs
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, revision, upstream, tracking] = line.split('\0');
        return {
          name: ref.replace(/^refs\/(heads|remotes)\//, ''),
          remote: ref.startsWith('refs/remotes/'),
          revision,
          upstream,
          tracking,
        };
      })
      .filter((item) => !item.name.endsWith('/HEAD'));
    if (!head.trim()) {
      if (!branch.trim())
        throw new ConflictException('Git HEAD is unavailable');
      if (!branches.some((item) => !item.remote && item.name === branch.trim()))
        branches.unshift({
          name: branch.trim(),
          remote: false,
          revision: '',
          upstream: '',
          tracking: '',
        });
    }
    const current = branches.find(
      (item) => !item.remote && item.name === branch.trim(),
    );
    return {
      branch: branch.trim() || null,
      head: head.trim(),
      fingerprint: gitStateFingerprint(
        head.trim(),
        branch.trim(),
        await readGitIndex(cwd),
      ),
      changes: parseGitChanges(status),
      branches,
      ahead: Number(/ahead (\d+)/.exec(current?.tracking ?? '')?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(current?.tracking ?? '')?.[1] ?? 0),
      upstream: current?.upstream || null,
      branchesLimited: branches.length >= 499,
      inspectedAt: Date.now(),
    };
  }

  /** Merge parents and unmerged stages only; no repository programs are executed. */
  async mergeStatus(projectId: string, copyId: string) {
    const cwd = await this.directory(projectId, copyId);
    const state = await this.snapshot(projectId, copyId);
    const mergeHead = await readFile(
      path.join(cwd, '.git/MERGE_HEAD'),
      'utf8',
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (mergeHead && !/^[a-f0-9]{40,64}\n?$/.test(mergeHead))
      throw new ConflictException('GIT_MERGE_STATE_UNSUPPORTED');
    const unmerged = await this.git(cwd, ['ls-files', '--unmerged', '-z']);
    return {
      ...state,
      mergeHead: mergeHead.trim() || null,
      conflicts: unmerged
        .split('\0')
        .filter(Boolean)
        .map((record) => {
          const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(record);
          if (!match)
            throw new ConflictException('GIT_MERGE_STATE_UNSUPPORTED');
          return {
            path: match[4],
            stage: Number(match[3]),
            mode: match[1],
            revision: match[2],
          };
        }),
    };
  }

  async conflictFile(projectId: string, copyId: string, input: unknown) {
    if (
      typeof input !== 'string' ||
      !input ||
      input.length > 2048 ||
      input.includes('\0')
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    const cwd = await this.directory(projectId, copyId);
    const state = await this.mergeStatus(projectId, copyId);
    const records = state.conflicts.filter((entry) => entry.path === input);
    if (!records.length) throw new ConflictException('GIT_STALE');
    const stages = await Promise.all(
      records.map(async (record) => {
        const size = Number(
          (await this.git(cwd, ['cat-file', '-s', record.revision])).trim(),
        );
        const blob =
          record.mode !== '160000' && size <= 128 * 1024
            ? await this.git(cwd, ['cat-file', 'blob', record.revision])
            : null;
        return {
          ...record,
          size,
          text: blob?.includes('\0') ? null : blob,
          limited: blob === null,
        };
      }),
    );
    return {
      path: input,
      fingerprint: state.fingerprint,
      mergeHead: state.mergeHead,
      stages,
      untrustedContent: true,
    };
  }

  async diff(projectId: string, copyId: string, input: unknown) {
    if (
      typeof input !== 'string' ||
      !input ||
      input.length > 4096 ||
      input.includes('\0')
    )
      throw new BadRequestException('Invalid Git file');
    const cwd = await this.directory(projectId, copyId);
    const changes = parseGitChanges(
      await this.git(cwd, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=all',
      ]),
    );
    const change = changes.find((item) => item.path === input);
    if (!change)
      throw new ConflictException('File has changed; refresh the working copy');
    if (change.status === '??')
      return { path: input, diff: '', untracked: true };
    // Literal pathspec: filenames containing glob syntax must not select other files.
    const names = [
      input,
      ...(change.originalPath ? [change.originalPath] : []),
    ].map((name) => `:(literal)${name}`);
    const head = (
      await this.git(
        cwd,
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        {},
        15000,
        [0, 1],
      )
    ).trim();
    const diff = await this.git(cwd, [
      'diff',
      ...(!head ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      ...(head ? ['HEAD'] : []),
      '--',
      ...names,
    ]);
    return { path: input, diff, untracked: false, stagedOnly: !head };
  }

  async stagedDiff(projectId: string, copyId: string, input?: unknown) {
    const cwd = await this.directory(projectId, copyId);
    const state = await this.snapshot(projectId, copyId);
    if (
      input !== undefined &&
      (typeof input !== 'string' ||
        !input ||
        input.length > 4096 ||
        input.includes('\0') ||
        !state.changes.some(
          (change) =>
            change.path === input && ![' ', '?'].includes(change.status[0]),
        ))
    )
      throw new BadRequestException('Invalid staged Git file');
    const index = await readGitIndex(cwd);
    if (
      gitStateFingerprint(state.head, state.branch ?? '', index) !==
      state.fingerprint
    )
      throw new ConflictException('GIT_STALE');
    const folder = await mkdtemp(path.join(tmpdir(), 'mergeron-review-'));
    try {
      const frozen = path.join(folder, 'index');
      if (index.length) await writeFile(frozen, index, { mode: 0o600 });
      const diff = await this.git(
        cwd,
        [
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          ...(state.head ? ['HEAD'] : []),
          '--',
          ...(typeof input === 'string' ? [`:(literal)${input}`] : []),
        ],
        { GIT_INDEX_FILE: frozen },
      );
      return { fingerprint: state.fingerprint, diff };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async commits(projectId: string, copyId: string) {
    const state = await this.snapshot(projectId, copyId);
    if (!state.head) return { items: [], limited: false };
    const cwd = await this.directory(projectId, copyId);
    const output = await this.git(cwd, [
      'log',
      '-31',
      '--format=%H%x00%aI%x00%an%x00%s',
      state.head,
      '--',
    ]);
    const rows = output.trim().split('\n').filter(Boolean);
    return {
      items: rows.slice(0, 30).map((row) => {
        const [sha, date, author, subject] = row.split('\0');
        return { sha, date, author, subject };
      }),
      limited: rows.length > 30,
    };
  }

  async graph(projectId: string, copyId: string) {
    const state = await this.snapshot(projectId, copyId);
    if (!state.head)
      return { items: [], limited: false, inspectedAt: Date.now() };
    const cwd = await this.directory(projectId, copyId);
    const output = await this.git(cwd, [
      'log',
      '--all',
      '--topo-order',
      '-101',
      '--format=%H%x00%P%x00%aI%x00%an%x00%s',
      state.head,
      '--',
    ]);
    const rows = output.trim().split('\n').filter(Boolean);
    return {
      items: rows.slice(0, 100).map((row) => {
        const [sha, parents, date, author, subject] = row.split('\0');
        return {
          sha,
          parents: parents ? parents.split(' ') : [],
          date,
          author,
          subject,
          current: sha === state.head,
          refs: state.branches
            .filter((b) => b.revision === sha)
            .map((b) => ({ name: b.name, remote: b.remote })),
        };
      }),
      limited: rows.length > 100 || state.branchesLimited,
      inspectedAt: Date.now(),
    };
  }

  /** Bounded, shell-free runner; callers own all arguments and environment overrides. */
  async git(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    timeoutMs = 15000,
    acceptedExitCodes: number[] = [0],
    input?: Buffer,
  ): Promise<string> {
    // Even `status` can invoke clean/process filters for tracked files. Read
    // names only (never values/secrets) and disable every configured filter.
    const keys = await this.runGit(
      cwd,
      [
        'config',
        '--null',
        '--name-only',
        '--get-regexp',
        '^filter\\..*\\.(clean|smudge|process|required)$',
      ],
      extraEnv,
      15000,
      [0, 1],
    );
    const overrides = keys
      .split('\0')
      .filter(Boolean)
      .flatMap((key) => [
        '-c',
        `${key}=${key.endsWith('.required') ? 'false' : ''}`,
      ]);
    return this.runGit(
      cwd,
      [...overrides, ...args],
      extraEnv,
      timeoutMs,
      acceptedExitCodes,
      input,
    );
  }

  private runGit(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    timeoutMs = 15000,
    acceptedExitCodes: number[] = [0],
    input?: Buffer,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      );
      const child = spawn(
        'git',
        [
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.worktree=.',
          '-c',
          'diff.external=',
          ...args,
        ],
        {
          cwd,
          env: {
            ...env,
            GIT_DIR: path.join(cwd, '.git'),
            GIT_WORK_TREE: cwd,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_PAGER: 'cat',
            LC_ALL: 'C',
            GIT_NO_REPLACE_OBJECTS: '1',
            ...extraEnv,
          },
          stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        },
      );
      const output: Buffer[] = [];
      if (input) {
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(input);
      }
      let size = 0;
      let failed = false;
      let diagnostics = '';
      const fail = (
        message = 'Git inspection failed or exceeded its limit',
      ) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new ConflictException(message));
      };
      const timer = setTimeout(() => fail('GIT_COMMAND_TIMEOUT'), timeoutMs);
      child.stdout!.on('data', (data: Buffer) => {
        size += data.length;
        if (size > 1024 * 1024) fail('GIT_OUTPUT_LIMIT_EXCEEDED');
        else output.push(data);
      });
      // Do not relay diagnostics: local config/paths may contain credentials.
      child.stderr!.on('data', (data: Buffer) => {
        if (diagnostics.length < 16384)
          diagnostics += data
            .toString('utf8')
            .slice(0, 16384 - diagnostics.length);
      });
      child.on('error', () => {
        clearTimeout(timer);
        fail();
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failed) return;
        if (code === null || !acceptedExitCodes.includes(code))
          fail(gitFailureCode(diagnostics));
        else resolve(Buffer.concat(output).toString('utf8'));
      });
    });
  }

  github(projectId: string, resourceId: string) {
    const { resource, secret } = this.resources.resolveForTransfer(
      projectId,
      resourceId,
    );
    if (!resource.enabled || resource.type !== 'git')
      throw new ConflictException('Git resource is unavailable');
    // Credentials are sent only to the fixed GitHub API, never to a supplied URL.
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
        resource.address ?? '',
      );
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2],
      token: secret?.token || secret?.password,
    };
  }

  private async githubGet<T>(
    repo: NonNullable<ReturnType<WorkspaceGitService['github']>>,
    endpoint: string,
    emptyRepository = false,
  ): Promise<T> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/${endpoint}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(repo.token ? { Authorization: `Bearer ${repo.token}` } : {}),
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        },
      );
      if (emptyRepository && response.status === 409) return [] as T;
      if (!response.ok) throw new Error();
      return (await response.json()) as T;
    } catch {
      throw new ConflictException(
        'GitHub is unavailable or access is denied. Check the resource credentials and permissions.',
      );
    }
  }

  async pullRequestPreparation(
    projectId: string,
    resourceId: string,
    head: string,
    base: string,
  ) {
    const repo = this.github(projectId, resourceId);
    if (!repo?.token) throw new ConflictException('GIT_GITHUB_TOKEN_REQUIRED');
    const [published, target, existing] = await Promise.all([
      this.githubGet<{ commit: { sha: string } }>(
        repo,
        `branches/${encodeURIComponent(head)}`,
      ),
      this.githubGet<{ commit: { sha: string } }>(
        repo,
        `branches/${encodeURIComponent(base)}`,
      ),
      this.githubGet<Array<{ number: number }>>(
        repo,
        `pulls?${new URLSearchParams({ state: 'open', head: `${repo.owner}:${head}`, base, per_page: '1' })}`,
      ),
    ]);
    return {
      head: published.commit.sha,
      baseHead: target.commit.sha,
      existingNumber: existing.length ? existing[0].number : null,
    };
  }

  async pullRequests(projectId: string, resourceId: string) {
    const repo = this.github(projectId, resourceId);
    if (!repo) return { supported: false, items: [], limited: false };
    const items = await this.githubGet<
      Array<{
        number: number;
        title: string;
        draft: boolean;
        head: { ref: string; sha: string };
        base: { ref: string };
      }>
    >(repo, 'pulls?state=open&per_page=30&sort=updated&direction=desc');
    return {
      supported: true,
      limited: items.length === 30,
      items: items.map((item) => ({
        number: item.number,
        title: item.title,
        draft: item.draft,
        branch: item.head.ref,
        base: item.base.ref,
        head: item.head.sha,
        url: `https://github.com/${repo.owner}/${repo.repo}/pull/${item.number}`,
      })),
    };
  }

  async remoteBranches(projectId: string, resourceId: string) {
    const repo = this.github(projectId, resourceId);
    if (!repo)
      return {
        supported: false,
        items: [],
        limited: false,
        inspectedAt: Date.now(),
      };
    const branches = await this.githubGet<
      Array<{ name: string; commit: { sha: string }; protected: boolean }>
    >(repo, 'branches?per_page=100');
    return {
      supported: true,
      items: branches.map((branch) => ({
        name: branch.name,
        revision: branch.commit.sha,
        protected: branch.protected,
      })),
      limited: branches.length === 100,
      inspectedAt: Date.now(),
    };
  }

  /** Bounded remote-only inspection. No clone, fetch, checkout or local mutation. */
  async remoteGraph(projectId: string, resourceId: string) {
    const repo = this.github(projectId, resourceId);
    if (!repo) throw new BadRequestException('Provider not supported');
    const branches = await this.remoteBranches(projectId, resourceId);
    type Commit = {
      sha: string;
      parents: Array<{ sha: string }>;
      commit: {
        author: { name: string; date: string } | null;
        message: string;
      };
    };
    const histories = await Promise.all(
      branches.items
        .slice(0, 8)
        .map((branch) =>
          this.githubGet<Commit[]>(
            repo,
            `commits?sha=${encodeURIComponent(branch.revision)}&per_page=30`,
            true,
          ),
        ),
    );
    const unique = new Map(
      histories.flat().map((commit) => [commit.sha, commit]),
    );
    const ordered: Commit[] = [];
    // Children before parents, including merges; dates are only a tie-breaker.
    while (unique.size) {
      const parents = new Set(
        [...unique.values()].flatMap((c) => c.parents.map((p) => p.sha)),
      );
      const candidates = [...unique.values()].filter(
        (c) => !parents.has(c.sha),
      );
      if (!candidates.length)
        throw new ConflictException('Invalid remote history');
      candidates.sort((a, b) =>
        (b.commit.author?.date ?? '').localeCompare(
          a.commit.author?.date ?? '',
        ),
      );
      for (const commit of candidates) {
        ordered.push(commit);
        unique.delete(commit.sha);
      }
    }
    return {
      items: ordered.slice(0, 100).map((c) => ({
        sha: c.sha,
        parents: c.parents.map((p) => p.sha),
        author: c.commit.author?.name ?? '',
        date: c.commit.author?.date ?? '',
        subject: c.commit.message.split('\n')[0],
        current: false,
        refs: branches.items
          .filter((b) => b.revision === c.sha)
          .map((b) => ({ name: b.name, remote: true })),
      })),
      limited:
        branches.limited ||
        branches.items.length > 8 ||
        histories.some((h) => h.length === 30) ||
        ordered.length > 100,
      inspectedAt: Date.now(),
    };
  }

  async remoteFiles(
    projectId: string,
    resourceId: string,
    inputPath: unknown,
    inputRef: unknown,
  ) {
    const filePath = inputPath ?? '';
    if (
      typeof filePath !== 'string' ||
      filePath.length > 2048 ||
      filePath.includes('\\') ||
      [...filePath].some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ) ||
      (filePath !== '' &&
        filePath
          .split('/')
          .some((part) => !part || part === '.' || part === '..'))
    )
      throw new BadRequestException('Invalid remote path');
    if (
      inputRef !== undefined &&
      (typeof inputRef !== 'string' || !/^[a-f0-9]{40,64}$/.test(inputRef))
    )
      throw new BadRequestException('Invalid remote revision');
    const repo = this.github(projectId, resourceId);
    if (!repo) throw new BadRequestException('Provider not supported');
    // Pin navigation to an immutable revision; never use response-provided URLs.
    let ref = inputRef;
    if (!ref) {
      const commits = await this.githubGet<Array<{ sha: string }>>(
        repo,
        'commits?per_page=1',
        true,
      );
      ref = commits[0]?.sha;
      if (!ref)
        return {
          ref: null,
          path: '',
          items: [],
          limited: false,
          content: null,
        };
      if (!/^[a-f0-9]{40,64}$/.test(ref))
        throw new ConflictException('Invalid remote revision');
    }
    type Entry = {
      type: string;
      name: string;
      path: string;
      size: number;
      encoding?: string;
      content?: string;
    };
    const data = await this.githubGet<Entry[] | Entry>(
      repo,
      `contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
    );
    if (Array.isArray(data))
      return {
        ref,
        path: filePath,
        items: data.slice(0, 200).map((item) => ({
          name: item.name,
          path: item.path,
          type: item.type,
          size: item.size,
        })),
        limited: data.length > 200,
        content: null,
      };
    const text =
      data.type === 'file' &&
      data.size <= 128 * 1024 &&
      data.encoding === 'base64' &&
      (data.content?.length ?? 0) <= 180000
        ? Buffer.from(data.content ?? '', 'base64').toString('utf8')
        : null;
    return {
      ref,
      path: filePath,
      items: null,
      limited: false,
      content: text && !text.includes('\0') ? text : null,
    };
  }

  async pullRequest(projectId: string, resourceId: string, number: string) {
    if (!/^[1-9]\d{0,8}$/.test(number))
      throw new BadRequestException('Invalid pull request');
    const repo = this.github(projectId, resourceId);
    if (!repo) throw new BadRequestException('Provider not supported');
    const pr = await this.githubGet<{
      number: number;
      title: string;
      body: string | null;
      updated_at: string;
      state: string;
      draft: boolean;
      mergeable: boolean | null;
      head: { sha: string; ref: string; repo: { full_name: string } | null };
      base: { sha: string; ref: string };
    }>(repo, `pulls/${number}`);
    if (
      pr.number !== Number(number) ||
      !/^[a-f0-9]{40,64}$/.test(pr.head?.sha) ||
      !Number.isFinite(Date.parse(pr.updated_at))
    )
      throw new ConflictException('GIT_INVALID_REMOTE_STATE');
    return {
      number: pr.number,
      title: pr.title,
      description: (pr.body ?? '').slice(0, 10000),
      descriptionLimited: (pr.body?.length ?? 0) > 10000,
      updatedAt: pr.updated_at,
      state: pr.state,
      draft: pr.draft,
      mergeable: pr.mergeable,
      head: pr.head.sha,
      branch: pr.head.ref,
      base: pr.base.ref,
      baseHead: pr.base.sha,
      sameRepository:
        pr.head.repo?.full_name.toLowerCase() ===
        `${repo.owner}/${repo.repo}`.toLowerCase(),
      url: `https://github.com/${repo.owner}/${repo.repo}/pull/${pr.number}`,
    };
  }

  async checks(projectId: string, resourceId: string, number: string) {
    if (!/^[1-9]\d{0,8}$/.test(number))
      throw new BadRequestException('Invalid pull request');
    const repo = this.github(projectId, resourceId);
    if (!repo) throw new BadRequestException('Provider not supported');
    const pr = await this.githubGet<{
      head: { sha: string };
      mergeable: boolean | null;
      mergeable_state: string;
      draft: boolean;
      base: { sha: string };
    }>(repo, `pulls/${number}`);
    if (!/^[a-f0-9]{40,64}$/.test(pr.head.sha))
      throw new ConflictException('Invalid GitHub revision');
    return {
      ...(await this.revisionChecks(repo, pr.head.sha)),
      baseHead: pr.base?.sha ?? null,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      draft: pr.draft,
    };
  }

  async merges(projectId: string, resourceId: string) {
    const repo = this.github(projectId, resourceId);
    if (!repo)
      return {
        supported: false,
        items: [],
        limited: false,
        inspectedAt: Date.now(),
      };
    // Bound both the history scan and the number of polling cards in the UI.
    const closed = await this.githubGet<
      Array<{
        number: number;
        title: string;
        merged_at: string | null;
        head: { ref: string };
        base: { ref: string };
      }>
    >(repo, 'pulls?state=closed&per_page=30&sort=updated&direction=desc');
    const merged = closed
      .filter((pr) => pr.merged_at)
      .sort((a, b) => b.merged_at!.localeCompare(a.merged_at!));
    return {
      supported: true,
      limited: closed.length === 30 || merged.length > 5,
      inspectedAt: Date.now(),
      items: merged.slice(0, 5).map((pr) => ({
        number: pr.number,
        title: pr.title,
        branch: pr.head.ref,
        base: pr.base.ref,
        mergedAt: pr.merged_at!,
        url: `https://github.com/${repo.owner}/${repo.repo}/pull/${pr.number}`,
      })),
    };
  }

  async mergeChecks(projectId: string, resourceId: string, number: string) {
    if (!/^[1-9]\d{0,8}$/.test(number))
      throw new BadRequestException('Invalid pull request');
    const repo = this.github(projectId, resourceId);
    if (!repo) throw new BadRequestException('Provider not supported');
    const pr = await this.githubGet<{
      merged: boolean;
      merge_commit_sha: string | null;
    }>(repo, `pulls/${number}`);
    if (!pr.merged || !pr.merge_commit_sha)
      throw new ConflictException('Pull request has not been merged');
    return {
      ...(await this.revisionChecks(repo, pr.merge_commit_sha)),
      url: `https://github.com/${repo.owner}/${repo.repo}/commit/${pr.merge_commit_sha}/checks`,
    };
  }

  private async revisionChecks(
    repo: NonNullable<ReturnType<WorkspaceGitService['github']>>,
    revision: string,
  ) {
    if (!/^[a-f0-9]{40,64}$/.test(revision))
      throw new ConflictException('Invalid GitHub revision');
    const [checks, statuses] = await Promise.all([
      this.githubGet<{
        total_count: number;
        check_runs: Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
        }>;
      }>(repo, `commits/${revision}/check-runs?per_page=100`),
      this.githubGet<{
        total_count: number;
        statuses: Array<{ id: number; context: string; state: string }>;
      }>(repo, `commits/${revision}/status?per_page=100`),
    ]);
    return {
      head: revision,
      limited: checks.total_count > 100 || statuses.total_count > 100,
      items: [
        ...checks.check_runs.map((item) => ({
          id: `check-${item.id}`,
          name: item.name,
          status:
            item.status === 'completed'
              ? (item.conclusion ?? 'unknown')
              : item.status,
        })),
        ...statuses.statuses.map((item) => ({
          id: `status-${item.id}`,
          name: item.context,
          status: item.state,
        })),
      ],
      inspectedAt: Date.now(),
    };
  }
}

/** Never expose raw Git diagnostics: they can contain credentials and paths. */
export function gitFailureCode(diagnostics: string): string {
  if (
    /permission to .* denied|write access to repository not granted|requested URL returned error: 403/i.test(
      diagnostics,
    )
  )
    return 'GIT_WRITE_ACCESS_DENIED';
  if (
    /authentication failed|could not read Username|invalid username or (?:password|token)|requested URL returned error: 401/i.test(
      diagnostics,
    )
  )
    return 'GIT_AUTH_REQUIRED';
  if (
    /non-fast-forward|fetch first|remote rejected|\[rejected\]|protected branch/i.test(
      diagnostics,
    )
  )
    return 'GIT_REMOTE_REJECTED';
  if (
    /could not resolve (?:host|proxy)|failed to connect|couldn't connect|connection timed out/i.test(
      diagnostics,
    )
  )
    return 'GIT_NETWORK_UNAVAILABLE';
  if (/SSL certificate problem|certificate verify failed/i.test(diagnostics))
    return 'GIT_TLS_ERROR';
  return 'Git inspection failed or exceeded its limit';
}

export async function readGitIndex(cwd: string): Promise<Buffer> {
  try {
    return await readFile(path.join(cwd, '.git/index'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return Buffer.alloc(0);
    throw error;
  }
}

export function gitStateFingerprint(
  head: string,
  branch: string,
  index: Buffer,
): string {
  return createHash('sha256')
    .update(head)
    .update('\0')
    .update(branch)
    .update('\0')
    .update(index)
    .digest('hex');
}

export function parseGitChanges(output: string): GitChange[] {
  const entries = output.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const originalPath = /[RC]/.test(status) ? entries[++i] : undefined;
    changes.push({
      path: entry.slice(3),
      status,
      ...(originalPath ? { originalPath } : {}),
    });
  }
  return changes;
}
