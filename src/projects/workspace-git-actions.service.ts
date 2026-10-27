import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  lstat,
  open,
  rename,
  realpath,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  currentAccess,
  requireExecutionAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { copyAgentIds, workAgentId } from './git-copy-ownership';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { projectActivity } from '../database/schema';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { gitCredentialHelper } from './git-credentials';
import {
  WorkspaceGitService,
  gitStateFingerprint,
} from './workspace-git.service';

@Injectable()
export class WorkspaceGitActionsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly git: WorkspaceGitService,
    private readonly copies: WorkspaceCopiesService,
    private readonly resources: WorkspaceResourcesService,
    private readonly gate: GitMutationGateService,
  ) {}

  private writable(projectId: string, resourceId: string) {
    requireExecutionAccess();
    const result = this.resources.resolveForTransfer(projectId, resourceId);
    if (
      !result.resource.enabled ||
      result.resource.type !== 'git' ||
      result.resource.accessMode !== 'read_write'
    )
      throw new ForbiddenException('GIT_READ_ONLY');
    return result;
  }

  private assertCopyAgent(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    const owners = copyAgentIds(this.db, projectId, copyId);
    if (!owners.length) return;
    if (
      typeof body.agentThreadId !== 'string' ||
      owners.length !== 1 ||
      owners[0] !== workAgentId(this.db, body.agentThreadId)
    )
      throw new ForbiddenException('GIT_COPY_OWNED');
    requireThreadAccess(body.agentThreadId);
  }

  private async stageInputs(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    this.assertCopyAgent(projectId, copyId, body);
    const { cwd, state } = await this.copyState(
      projectId,
      copyId,
      body.fingerprint,
    );
    if (
      !Array.isArray(body.paths) ||
      !body.paths.length ||
      body.paths.length > 100
    )
      throw new BadRequestException('GIT_FILES_REQUIRED');
    if ((await this.git.git(cwd, ['ls-files', '--unmerged'])).trim())
      throw new ConflictException('GIT_IN_PROGRESS');
    const records: {
      path: string;
      mode: string;
      data: Buffer;
      digest: string;
    }[] = [];
    const names = new Set<string>();
    for (const name of body.paths as unknown[]) {
      if (
        typeof name !== 'string' ||
        !state.changes.some((c) => c.path === name)
      )
        throw new ConflictException('GIT_STALE');
      const change = state.changes.find((c) => c.path === name)!;
      for (const entry of [
        name,
        ...(change.originalPath ? [change.originalPath] : []),
      ])
        names.add(entry);
    }
    let total = 0;
    for (const name of names) {
      if (
        name.includes('\0') ||
        path.isAbsolute(name) ||
        name.split('/').some((p) => p === '..' || p.toLowerCase() === '.git')
      )
        throw new BadRequestException('GIT_FILE_UNSAFE');
      const target = path.join(cwd, name);
      for (
        let parent = path.dirname(target);
        parent !== cwd;
        parent = path.dirname(parent)
      ) {
        if (
          !parent.startsWith(cwd + path.sep) ||
          (await lstat(parent)).isSymbolicLink()
        )
          throw new ConflictException('GIT_FILE_UNSAFE');
      }
      const entry = await lstat(target).catch(() => null);
      if (!entry) {
        records.push({
          path: name,
          mode: '0',
          data: Buffer.alloc(0),
          digest: '',
        });
        continue;
      }
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.size > 8 * 1024 * 1024 ||
        total + entry.size > 16 * 1024 * 1024
      )
        throw new ConflictException('GIT_FILE_UNSAFE');
      if (!(await realpath(target)).startsWith(cwd + path.sep))
        throw new ConflictException('GIT_FILE_UNSAFE');
      const file = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let data: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
          throw new ConflictException('GIT_FILE_UNSAFE');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await file.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > stat.size) throw new ConflictException('GIT_STALE');
        data = Buffer.from(buffer.subarray(0, length));
      } finally {
        await file.close();
      }
      total += data.length;
      if (data.length > 8 * 1024 * 1024 || total > 16 * 1024 * 1024)
        throw new ConflictException('GIT_FILE_UNSAFE');
      records.push({
        path: name,
        mode: entry.mode & 0o111 ? '100755' : '100644',
        data,
        digest: createHash('sha256').update(data).digest('hex'),
      });
    }
    const reviewFingerprint = createHash('sha256')
      .update(state.fingerprint)
      .update(
        JSON.stringify(
          records.map(({ path, mode, digest }) => ({ path, mode, digest })),
        ),
      )
      .digest('hex');
    return { cwd, state, records, reviewFingerprint };
  }

  async stageReview(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    this.body(body);
    const { records, reviewFingerprint } = await this.stageInputs(
      projectId,
      copyId,
      body,
    );
    return {
      reviewFingerprint,
      files: records.map((r) => ({
        path: r.path,
        deleted: r.mode === '0',
        binary: r.data.includes(0),
        text: r.data.includes(0)
          ? ''
          : r.data.subarray(0, 65536).toString('utf8'),
        truncated: r.data.length > 65536,
      })),
    };
  }

  async stage(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    this.body(body);
    return this.gate.mutate(async () => {
      const reviewed = await this.stageInputs(projectId, copyId, body);
      if (body.reviewFingerprint !== reviewed.reviewFingerprint)
        throw new ConflictException('GIT_STALE');
      const { cwd, state, records } = reviewed;
      const folder = await mkdtemp(path.join(tmpdir(), 'mergeron-stage-'));
      const index = path.join(cwd, '.git/index');
      const lockPath = index + '.lock';
      let lock: Awaited<ReturnType<typeof open>> | null = null;
      try {
        lock = await open(lockPath, 'wx', 0o600).catch(() => {
          throw new ConflictException('GIT_BUSY');
        });
        const frozen = path.join(folder, 'index');
        const previous = await readFile(index).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        );
        const env = { GIT_INDEX_FILE: frozen };
        if (previous) await writeFile(frozen, previous, { mode: 0o600 });
        else await this.git.git(cwd, ['read-tree', '--empty'], env);
        let entries = '';
        for (const record of records) {
          const sha =
            record.mode === '0'
              ? '0'.repeat(state.head.length || 40)
              : (
                  await this.git.git(
                    cwd,
                    ['hash-object', '-w', '--no-filters', '--stdin'],
                    {},
                    15000,
                    [0],
                    record.data,
                  )
                ).trim();
          if (!/^[a-f0-9]{40,64}$/.test(sha))
            throw new ConflictException('GIT_OPERATION_FAILED');
          entries += `${record.mode} ${sha}\t${record.path}\0`;
        }
        await this.git.git(
          cwd,
          ['update-index', '-z', '--index-info'],
          env,
          15000,
          [0],
          Buffer.from(entries),
        );
        if (
          (await this.stageInputs(projectId, copyId, body))
            .reviewFingerprint !== reviewed.reviewFingerprint
        )
          throw new ConflictException('GIT_STALE');
        await lock.writeFile(await readFile(frozen));
        await lock.close();
        await rename(lockPath, index);
        lock = null;
        this.audit(projectId, copyId, 'git_stage', {
          paths: records.map((r) => r.path),
        });
        return { prepared: true };
      } finally {
        if (lock) {
          await lock.close().catch(() => undefined);
          await rm(lockPath, { force: true });
        }
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

  async unstage(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    this.body(body);
    return this.gate.mutate(async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { cwd, state } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      if (
        !Array.isArray(body.paths) ||
        !body.paths.length ||
        body.paths.length > 100
      )
        throw new BadRequestException('GIT_FILES_REQUIRED');
      const names = new Set<string>();
      for (const name of body.paths as unknown[]) {
        const change = state.changes.find(
          (c) => c.path === name && ![' ', '?'].includes(c.status[0]),
        );
        if (!change) throw new ConflictException('GIT_STALE');
        names.add(change.path);
        if (change.originalPath) names.add(change.originalPath);
      }
      const folder = await mkdtemp(path.join(tmpdir(), 'mergeron-unstage-'));
      const index = path.join(cwd, '.git/index');
      const lockPath = index + '.lock';
      let lock: Awaited<ReturnType<typeof open>> | null = null;
      try {
        lock = await open(lockPath, 'wx', 0o600).catch(() => {
          throw new ConflictException('GIT_BUSY');
        });
        await this.copyState(projectId, copyId, body.fingerprint);
        const frozen = path.join(folder, 'index');
        await writeFile(frozen, await readFile(index), { mode: 0o600 });
        const env = { GIT_INDEX_FILE: frozen };
        // A pathspec reset changes only the private index, never the files.
        if (state.head)
          await this.git.git(
            cwd,
            [
              'reset',
              '-q',
              state.head,
              '--',
              ...[...names].map((n) => `:(literal)${n}`),
            ],
            env,
          );
        else
          await this.git.git(
            cwd,
            ['update-index', '--force-remove', '--', ...names],
            env,
          );
        await this.copyState(projectId, copyId, body.fingerprint);
        await lock.writeFile(await readFile(frozen));
        await lock.close();
        await rename(lockPath, index);
        lock = null;
      } finally {
        if (lock) {
          await lock.close().catch(() => undefined);
          await rm(lockPath, { force: true });
        }
        await rm(folder, { recursive: true, force: true });
      }
      this.audit(projectId, copyId, 'git_unstage', { paths: [...names] });
      return { prepared: false };
    });
  }

  async createBranch(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    requireExecutionAccess();
    this.body(body);
    if (
      body.confirmation !== 'CREATE_LOCAL_BRANCH' ||
      typeof body.name !== 'string' ||
      !body.name ||
      body.name.length > 200 ||
      body.name.startsWith('-') ||
      typeof body.startRef !== 'string' ||
      typeof body.startRevision !== 'string' ||
      typeof body.checkout !== 'boolean'
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    const name = body.name;
    return this.gate.mutate(async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { cwd, state } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      try {
        if (
          (
            await this.git.git(cwd, ['check-ref-format', '--branch', name])
          ).trim() !== name
        )
          throw new Error('Invalid name');
      } catch {
        throw new BadRequestException('GIT_BRANCH_NAME_INVALID');
      }
      const start =
        body.startRef === 'HEAD'
          ? state.head
          : state.branches.find(
              (branch) =>
                `${branch.remote ? 'refs/remotes/' : 'refs/heads/'}${branch.name}` ===
                body.startRef,
            )?.revision;
      if (
        !start ||
        start !== body.startRevision ||
        !/^[a-f0-9]{40,64}$/.test(start)
      )
        throw new ConflictException('GIT_STALE');
      const ref = `refs/heads/${name}`;
      if (
        (await this.git.git(cwd, ['for-each-ref', '--format=%(refname)', ref]))
          .trim()
          .split('\n')
          .includes(ref)
      )
        throw new ConflictException('GIT_BRANCH_EXISTS');
      if (
        body.checkout &&
        (
          await this.git.git(cwd, [
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignore-submodules=none',
          ])
        ).trim()
      )
        throw new ConflictException('GIT_WORKTREE_DIRTY');
      await this.copyState(projectId, copyId, body.fingerprint);
      // Never reset an existing branch, force a checkout, fetch or push here.
      await this.git.git(
        cwd,
        body.checkout
          ? ['switch', '--no-track', '-c', name, start]
          : ['branch', '--no-track', '--', name, start],
      );
      this.audit(projectId, copyId, 'git_branch_created', {
        branch: name,
        startRef: body.startRef,
        sha: start,
        checkedOut: body.checkout,
      });
      return { branch: name, sha: start, checkedOut: body.checkout };
    });
  }

  private async copyState(
    projectId: string,
    copyId: string,
    fingerprint: unknown,
  ) {
    requireExecutionAccess();
    const copy = this.copies.list(projectId).find((item) => item.id === copyId);
    if (!copy) throw new BadRequestException('GIT_UNAVAILABLE');
    if (copy.accessMode !== 'read_write')
      throw new ForbiddenException('GIT_READ_ONLY');
    const source = this.writable(projectId, copy.sourceResourceId);
    const cwd = await this.git.directory(projectId, copyId);
    const state = await this.git.snapshot(projectId, copyId);
    if (typeof fingerprint !== 'string' || fingerprint !== state.fingerprint)
      throw new ConflictException('GIT_STALE');
    if (
      !state.branch ||
      state.branch.length > 200 ||
      state.branch.startsWith('-')
    )
      throw new ConflictException('GIT_BRANCH_REQUIRED');
    try {
      await this.git.git(cwd, ['check-ref-format', '--branch', state.branch]);
    } catch {
      throw new ConflictException('GIT_BRANCH_REQUIRED');
    }
    for (const entry of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      if (await lstat(path.join(cwd, '.git', entry)).catch(() => null))
        throw new ConflictException('GIT_IN_PROGRESS');
    }
    return { copy, source, cwd, state, branch: state.branch };
  }

  async commit(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    requireExecutionAccess();
    this.body(body);
    const access = currentAccess();
    const person =
      access?.identity.kind === 'person' && access.identity.personId
        ? access.identities.resolvePerson(access.identity.personId)
        : undefined;
    const authorName = person?.name?.trim() ?? '';
    const authorEmail = person?.email?.trim() ?? '';
    if (
      person?.kind !== 'person' ||
      !person.personId ||
      !person.active ||
      !authorName ||
      authorName.length > 120 ||
      authorEmail.length > 254 ||
      /[<>]/.test(authorName) ||
      !/^[^\s<>@]+@[^\s<>@]+$/.test(authorEmail) ||
      [...authorName, ...authorEmail].some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      )
    )
      throw new BadRequestException('GIT_IDENTITY_REQUIRED');
    return this.gate.mutate(async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { cwd, state, branch } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      const message = this.text(body.message, 4000);
      if (
        !state.changes.some(
          (item) => item.status[0] !== ' ' && item.status[0] !== '?',
        )
      )
        throw new ConflictException('GIT_NOTHING_STAGED');
      if ((await this.git.git(cwd, ['ls-files', '--unmerged'])).trim())
        throw new ConflictException('GIT_IN_PROGRESS');
      const folder = await mkdtemp(path.join(tmpdir(), 'mergeron-commit-'));
      try {
        // Freeze the reviewed index, not the worktree. Never run add/clean filters,
        // and never overwrite an index that a terminal user changes concurrently.
        const index = await readFile(path.join(cwd, '.git/index'));
        if (gitStateFingerprint(state.head, branch, index) !== body.fingerprint)
          throw new ConflictException('GIT_STALE');
        const frozenIndex = path.join(folder, 'index');
        await writeFile(frozenIndex, index, { mode: 0o600 });
        const env = {
          GIT_INDEX_FILE: frozenIndex,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: authorEmail,
        };
        const tree = (await this.git.git(cwd, ['write-tree'], env)).trim();
        const sha = (
          await this.git.git(
            cwd,
            [
              '-c',
              'commit.gpgsign=false',
              'commit-tree',
              tree,
              ...(state.head ? ['-p', state.head] : []),
              '-m',
              message,
            ],
            env,
          )
        ).trim();
        if (!/^[a-f0-9]{40,64}$/.test(sha))
          throw new ConflictException('GIT_OPERATION_FAILED');
        if (
          (await this.git.git(cwd, ['branch', '--show-current'])).trim() !==
          branch
        )
          throw new ConflictException('GIT_STALE');
        await this.copyState(projectId, copyId, body.fingerprint);
        await this.git.git(cwd, [
          'update-ref',
          '-m',
          'Mergeron: commit confirmed staged changes',
          `refs/heads/${branch}`,
          sha,
          state.head || '0'.repeat(sha.length),
        ]);
        this.audit(projectId, copyId, 'git_commit', { branch, sha });
        return { sha, branch };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

  async push(projectId: string, copyId: string, body: Record<string, unknown>) {
    requireExecutionAccess();
    this.body(body);
    return this.gate.mutate(async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { source, cwd, state, branch } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      if (!state.head) throw new ConflictException('GIT_NO_COMMIT');
      if (body.address !== source.resource.address)
        throw new ConflictException('GIT_STALE');
      if (/[\r\n]/.test(cwd)) throw new ConflictException('GIT_UNAVAILABLE');
      let url: URL;
      try {
        url = new URL(source.resource.address!);
      } catch {
        throw new BadRequestException('GIT_HTTPS_REQUIRED');
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new BadRequestException('GIT_HTTPS_REQUIRED');
      if (!source.secret?.token && !source.secret?.password)
        throw new ForbiddenException('GIT_AUTH_REQUIRED');
      const folder = await mkdtemp(path.join(tmpdir(), 'mergeron-push-'));
      try {
        // A clean temporary Git config prevents local url rewrites, pushurls,
        // credential helpers, hooks or ssh commands from redirecting credentials.
        const format = (
          await this.git.git(cwd, ['rev-parse', '--show-object-format'])
        ).trim();
        if (!['sha1', 'sha256'].includes(format))
          throw new ConflictException('GIT_UNAVAILABLE');
        await this.git.git(folder, [
          'init',
          '--quiet',
          `--object-format=${format}`,
        ]);
        await writeFile(
          path.join(folder, '.git/objects/info/alternates'),
          `${path.join(cwd, '.git/objects')}\n`,
        );
        const env = {
          MERGERON_GIT_USERNAME: source.secret?.username || 'oauth2',
          MERGERON_GIT_TOKEN:
            source.secret?.token || source.secret?.password || '',
        };
        const current = await this.copyState(
          projectId,
          copyId,
          body.fingerprint,
        );
        if (current.source.resource.address !== body.address)
          throw new ConflictException('GIT_STALE');
        await this.git.git(
          folder,
          [
            '-c',
            'credential.helper=',
            '-c',
            `credential.helper=${gitCredentialHelper}`,
            '-c',
            'http.followRedirects=false',
            '-c',
            'http.sslVerify=true',
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.https.allow=always',
            'push',
            '--no-verify',
            '--porcelain',
            '--',
            url.href,
            `${state.head}:refs/heads/${branch}`,
          ],
          env,
          120000,
        );
        this.audit(projectId, copyId, 'git_push', { branch, sha: state.head });
        return { sha: state.head, branch };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

  async createPullRequest(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    requireExecutionAccess();
    this.body(body);
    if (
      body.confirmation !== 'CREATE_PULL_REQUEST' ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.length > 256 ||
      typeof body.description !== 'string' ||
      body.description.length > 60000 ||
      typeof body.base !== 'string' ||
      !body.base ||
      body.base.length > 200 ||
      body.base.startsWith('-') ||
      typeof body.draft !== 'boolean'
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    const pr = {
      title: body.title.trim(),
      base: body.base,
      description: body.description,
      draft: body.draft,
    };
    return this.gate.mutate(async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { copy, source, cwd, state, branch } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      if (
        !state.head ||
        body.head !== state.head ||
        body.address !== source.resource.address
      )
        throw new ConflictException('GIT_STALE');
      if (pr.base === branch)
        throw new BadRequestException('GIT_PR_SAME_BRANCH');
      try {
        if (
          (
            await this.git.git(cwd, ['check-ref-format', '--branch', pr.base])
          ).trim() !== pr.base
        )
          throw new Error();
      } catch {
        throw new BadRequestException('GIT_INVALID_INPUT');
      }
      const repo = this.git.github(projectId, copy.sourceResourceId);
      if (!repo?.token)
        throw new ForbiddenException('GIT_GITHUB_TOKEN_REQUIRED');
      const prepared = await this.git.pullRequestPreparation(
        projectId,
        copy.sourceResourceId,
        branch,
        pr.base,
      );
      if (prepared.head !== state.head)
        throw new ConflictException('GIT_PR_PUSH_REQUIRED');
      if (prepared.existingNumber)
        return {
          number: prepared.existingNumber,
          url: `https://github.com/${repo.owner}/${repo.repo}/pull/${prepared.existingNumber}`,
          existing: true,
        };
      const current = await this.copyState(projectId, copyId, body.fingerprint);
      if (current.source.resource.address !== body.address)
        throw new ConflictException('GIT_STALE');
      this.assertCopyAgent(projectId, copyId, body);
      if (
        this.git.github(projectId, copy.sourceResourceId)?.token !== repo.token
      )
        throw new ConflictException('GIT_STALE');
      let response: Response;
      try {
        response = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(20000),
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              Authorization: `Bearer ${repo.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              title: pr.title,
              body: pr.description,
              head: branch,
              base: pr.base,
              draft: pr.draft,
              maintainer_can_modify: false,
            }),
          },
        );
      } catch {
        throw new ConflictException('GIT_OUTCOME_UNKNOWN');
      }
      if (!response.ok)
        throw new ConflictException(
          response.status >= 500
            ? 'GIT_OUTCOME_UNKNOWN'
            : 'GIT_PR_CREATE_FAILED',
        );
      let result: { number?: number };
      try {
        result = (await response.json()) as { number?: number };
      } catch {
        throw new ConflictException('GIT_OUTCOME_UNKNOWN');
      }
      if (
        !Number.isSafeInteger(result.number) ||
        !result.number ||
        result.number < 1
      )
        throw new ConflictException('GIT_OUTCOME_UNKNOWN');
      this.audit(projectId, copyId, 'git_pr_created', {
        number: result.number,
        branch,
        base: pr.base,
        head: state.head,
        draft: pr.draft,
      });
      return {
        number: result.number,
        url: `https://github.com/${repo.owner}/${repo.repo}/pull/${result.number}`,
        existing: false,
      };
    });
  }

  async merge(
    projectId: string,
    resourceId: string,
    number: string,
    body: Record<string, unknown>,
  ) {
    requireExecutionAccess();
    this.body(body);
    return this.gate.mutate(async () => {
      const source = this.writable(projectId, resourceId);
      if (body.address !== source.resource.address)
        throw new ConflictException('GIT_STALE');
      const repo = this.git.github(projectId, resourceId);
      if (!repo?.token)
        throw new ForbiddenException('GIT_GITHUB_TOKEN_REQUIRED');
      const state = await this.git.checks(projectId, resourceId, number);
      if (
        body.head !== state.head ||
        !state.baseHead ||
        body.baseHead !== state.baseHead
      )
        throw new ConflictException('GIT_STALE');
      if (
        state.draft ||
        state.mergeable !== true ||
        state.mergeableState !== 'clean' ||
        state.limited ||
        !state.items.length ||
        state.items.some(
          (item) => !['success', 'neutral', 'skipped'].includes(item.status),
        )
      )
        throw new ConflictException('GIT_MERGE_BLOCKED');
      let response: Response;
      const current = this.writable(projectId, resourceId);
      if (body.address !== current.resource.address)
        throw new ConflictException('GIT_STALE');
      try {
        response = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${number}/merge`,
          {
            method: 'PUT',
            redirect: 'error',
            signal: AbortSignal.timeout(20000),
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              Authorization: `Bearer ${repo.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sha: state.head, merge_method: 'merge' }),
          },
        );
      } catch {
        throw new ConflictException('GIT_OUTCOME_UNKNOWN');
      }
      if (!response.ok) throw new ConflictException('GIT_MERGE_BLOCKED');
      const result = (await response.json()) as {
        merged?: boolean;
        sha?: string;
      };
      if (!result.merged || !result.sha)
        throw new ConflictException('GIT_MERGE_BLOCKED');
      this.audit(projectId, resourceId, 'git_pr_merged', {
        number,
        sha: result.sha,
      });
      return { sha: result.sha, merged: true };
    });
  }

  private text(value: unknown, max: number) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > max ||
      value.includes('\0')
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    return value.trim();
  }
  private body(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException('GIT_INVALID_INPUT');
  }
  private audit(
    projectId: string,
    entityId: string,
    action: string,
    details: Record<string, unknown>,
  ) {
    const identity = currentAccess()?.identity;
    this.db
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        entityType: 'workspace_git',
        entityId,
        action,
        label:
          action === 'git_stage'
            ? 'Préparation de fichiers pour un commit'
            : action === 'git_unstage'
              ? 'Retrait de fichiers du prochain commit'
              : action === 'git_commit'
                ? 'Commit Git'
                : action === 'git_push'
                  ? 'Push Git'
                  : action === 'git_branch_created'
                    ? 'Création de branche Git locale'
                    : action === 'git_pr_created'
                      ? 'Création de pull request'
                      : 'Fusion de pull request',
        details,
        actorPersonId: identity?.personId ?? null,
        actorName: identity?.name ?? 'Système',
        createdAt: Date.now(),
      })
      .run();
  }
}
