import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';

export interface GitChange {
  path: string;
  originalPath?: string;
  status: string;
}

/** Read-only inspection of registered copies. Never accepts a client-provided cwd or command. */
@Injectable()
export class WorkspaceGitService {
  constructor(
    private readonly copies: WorkspaceCopiesService,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  private async directory(projectId: string, copyId: string) {
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
    return cwd;
  }

  async snapshot(projectId: string, copyId: string) {
    const cwd = await this.directory(projectId, copyId);
    const [branch, head, status, refs] = await Promise.all([
      this.git(cwd, ['branch', '--show-current']),
      this.git(cwd, ['rev-parse', '--verify', 'HEAD']),
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
    const current = branches.find(
      (item) => !item.remote && item.name === branch.trim(),
    );
    return {
      branch: branch.trim() || null,
      head: head.trim(),
      changes: parseGitChanges(status),
      branches,
      ahead: Number(/ahead (\d+)/.exec(current?.tracking ?? '')?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(current?.tracking ?? '')?.[1] ?? 0),
      upstream: current?.upstream || null,
      branchesLimited: branches.length >= 499,
      inspectedAt: Date.now(),
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
    const diff = await this.git(cwd, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      'HEAD',
      '--',
      ...names,
    ]);
    return { path: input, diff, untracked: false };
  }

  /** Bounded, shell-free reads, with executable Git extensions disabled. */
  private git(cwd: string, args: string[]): Promise<string> {
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
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const output: Buffer[] = [];
      let size = 0;
      let failed = false;
      const fail = () => {
        if (failed) return;
        failed = true;
        child.kill('SIGKILL');
        reject(
          new ConflictException('Git inspection failed or exceeded its limit'),
        );
      };
      const timer = setTimeout(fail, 15000);
      child.stdout.on('data', (data: Buffer) => {
        size += data.length;
        if (size > 1024 * 1024) fail();
        else output.push(data);
      });
      // Do not relay diagnostics: local config/paths may contain credentials.
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        fail();
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0) fail();
        else resolve(Buffer.concat(output).toString('utf8'));
      });
    });
  }

  private github(projectId: string, resourceId: string) {
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
      if (!response.ok) throw new Error();
      return (await response.json()) as T;
    } catch {
      throw new ConflictException(
        'GitHub is unavailable or access is denied. Check the resource credentials and permissions.',
      );
    }
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
    }>(repo, `pulls/${number}`);
    if (!/^[a-f0-9]{40,64}$/.test(pr.head.sha))
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
      }>(repo, `commits/${pr.head.sha}/check-runs?per_page=100`),
      this.githubGet<{
        total_count: number;
        statuses: Array<{ id: number; context: string; state: string }>;
      }>(repo, `commits/${pr.head.sha}/status?per_page=100`),
    ]);
    return {
      head: pr.head.sha,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      draft: pr.draft,
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
