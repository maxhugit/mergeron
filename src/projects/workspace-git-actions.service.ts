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

/** Server-only capability, never parsed from an HTTP request body. */
export interface AgentGitPublisher {
  threadId: string;
  assertActive: () => void;
}
/** Separate server-only capability: never accepted from a request body. */
export interface AgentGitPreparer {
  threadId: string;
  assertActive: () => void;
}

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
      true,
    );
    if (
      !Array.isArray(body.paths) ||
      !body.paths.length ||
      body.paths.length > 100
    )
      throw new BadRequestException('GIT_FILES_REQUIRED');
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
    preparer?: AgentGitPreparer,
  ) {
    this.body(body);
    const copy = { projectId, copyId };
    return this.localPreparation(copy, preparer, body, async () => {
      const reviewed = await this.stageInputs(projectId, copyId, body);
      if (body.reviewFingerprint !== reviewed.reviewFingerprint)
        throw new ConflictException('GIT_STALE');
      const { cwd, state, records } = reviewed;
      preparer?.assertActive();
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
        preparer?.assertActive();
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
    preparer?: AgentGitPreparer,
  ) {
    this.body(body);
    const copy = { projectId, copyId };
    return this.localPreparation(copy, preparer, body, async () => {
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
        preparer?.assertActive();
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
    preparer?: AgentGitPreparer,
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
    const copy = { projectId, copyId };
    return this.localPreparation(copy, preparer, body, async () => {
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
      preparer?.assertActive();
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

  async retrieveBranch(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    preparer?: AgentGitPreparer,
    tracking = false,
    cleanRequired = false,
  ) {
    requireExecutionAccess();
    this.body(body);
    if (
      body.confirmation !== 'RETRIEVE_REMOTE_BRANCH' ||
      typeof body.name !== 'string' ||
      !body.name ||
      body.name.length > 200 ||
      body.name.startsWith('-') ||
      typeof body.revision !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(body.revision)
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    const name = body.name;
    const copy = { projectId, copyId };
    return this.localPreparation(copy, preparer, body, async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { source, cwd, state } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      if (!state.head) throw new ConflictException('GIT_NO_COMMIT');
      if (cleanRequired && (!state.branch || state.changes.length))
        throw new ConflictException(
          state.branch ? 'GIT_WORKTREE_DIRTY' : 'GIT_BRANCH_REQUIRED',
        );
      if (source.resource.address !== body.address)
        throw new ConflictException('GIT_STALE');
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
      try {
        if (
          (
            await this.git.git(cwd, ['check-ref-format', '--branch', name])
          ).trim() !== name
        )
          throw new Error();
      } catch {
        throw new BadRequestException('GIT_BRANCH_NAME_INVALID');
      }
      const ref = tracking
        ? `refs/remotes/mergeron/${name}`
        : `refs/heads/${name}`;
      const old = tracking
        ? (
            await this.git.git(
              cwd,
              ['rev-parse', '--verify', '--quiet', ref],
              {},
              15000,
              [0, 1],
            )
          ).trim()
        : '';
      const checkAbsent = async () => {
        if (
          (
            await this.git.git(
              cwd,
              ['symbolic-ref', '--quiet', ref],
              {},
              15000,
              [0, 1],
            )
          ).trim()
        )
          throw new ConflictException('GIT_BRANCH_EXISTS');
        if (
          (
            await this.git.git(cwd, [
              'for-each-ref',
              '--format=%(refname)',
              ref,
            ])
          )
            .trim()
            .split('\n')
            .includes(ref) &&
          !tracking
        )
          throw new ConflictException('GIT_BRANCH_EXISTS');
      };
      await checkAbsent();
      const folder = await mkdtemp(path.join(tmpdir(), 'mergeron-retrieve-'));
      try {
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
        // Network Git runs in a clean repository: no local URL rewrites,
        // credential programs, hooks or remote settings can redirect secrets.
        // Only immutable Git objects are added to the destination. No refs,
        // FETCH_HEAD, index or files in the working copy are touched by fetch.
        const env = {
          GIT_OBJECT_DIRECTORY: path.join(cwd, '.git/objects'),
          MERGERON_GIT_USERNAME: source.secret?.username || 'oauth2',
          MERGERON_GIT_TOKEN:
            source.secret?.token || source.secret?.password || '',
        };
        preparer?.assertActive();
        const before = await this.copyState(
          projectId,
          copyId,
          body.fingerprint,
        );
        if (
          before.source.resource.address !== body.address ||
          (before.source.secret?.token ||
            before.source.secret?.password ||
            '') !== env.MERGERON_GIT_TOKEN
        )
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
            '-c',
            'fetch.fsckObjects=true',
            '-c',
            'gc.auto=0',
            'fetch',
            '--no-tags',
            '--no-recurse-submodules',
            '--no-auto-maintenance',
            '--no-write-fetch-head',
            '--',
            url.href,
            `refs/heads/${name}:refs/mergeron/retrieved`,
          ],
          env,
          120000,
        );
        const sha = (
          await this.git.git(
            folder,
            ['rev-parse', '--verify', 'refs/mergeron/retrieved^{commit}'],
            env,
          )
        ).trim();
        if (sha !== body.revision) throw new ConflictException('GIT_STALE');
        this.assertCopyAgent(projectId, copyId, body);
        const current = await this.copyState(
          projectId,
          copyId,
          body.fingerprint,
        );
        if (
          current.cwd !== cwd ||
          current.source.resource.address !== body.address
        )
          throw new ConflictException('GIT_STALE');
        await checkAbsent();
        preparer?.assertActive();
        // Git's create transaction refuses existing branch tips atomically, including
        // a branch created concurrently after the last UI/server inspection.
        await this.git.git(
          cwd,
          ['update-ref', '--stdin'],
          {},
          15000,
          [0],
          Buffer.from(
            `option no-deref\n${tracking ? `update ${ref} ${sha} ${old || '0'.repeat(sha.length)}` : `create ${ref} ${sha}`}\n`,
          ),
        );
        this.audit(projectId, copyId, 'git_remote_branch_retrieved', {
          branch: name,
          sha,
          activeBranch: state.branch,
        });
        return { branch: name, ref, sha, activeBranch: state.branch };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

  async localBranchAction(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    preparer?: AgentGitPreparer,
    remoteMerge = false,
  ) {
    requireExecutionAccess();
    this.body(body);
    if (
      !['switch', 'merge', 'delete'].includes(String(body.action)) ||
      body.confirmation !==
        (body.action === 'delete'
          ? 'DELETE_LOCAL_BRANCH'
          : 'LOCAL_BRANCH_ACTION') ||
      typeof body.name !== 'string' ||
      typeof body.revision !== 'string' ||
      (remoteMerge && body.action !== 'merge')
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    const copy = { projectId, copyId };
    return this.localPreparation(copy, preparer, body, async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { cwd, state, source } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      if (remoteMerge && source.resource.address !== body.address)
        throw new ConflictException('GIT_STALE');
      const target = state.branches.find(
        (b) => b.remote === remoteMerge && b.name === body.name,
      );
      if (body.action === 'delete' && target?.name === state.branch)
        throw new ConflictException('GIT_BRANCH_ACTIVE');
      if (
        !target ||
        target.revision !== body.revision ||
        target.name === state.branch ||
        !/^[a-f0-9]{40,64}$/.test(target.revision)
      )
        throw new ConflictException('GIT_STALE');
      await this.git.git(cwd, ['check-ref-format', '--branch', target.name]);
      const clean = async () => {
        await this.copyState(projectId, copyId, body.fingerprint);
        if (
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
        if (
          (
            await this.git.git(cwd, [
              'rev-parse',
              '--verify',
              `refs/${remoteMerge ? 'remotes' : 'heads'}/${target.name}`,
            ])
          ).trim() !== target.revision
        )
          throw new ConflictException('GIT_STALE');
      };
      await clean();
      if (body.action === 'delete') {
        const worktrees = await this.git.git(cwd, [
          'worktree',
          'list',
          '--porcelain',
          '-z',
        ]);
        if (worktrees.split('\0').includes(`branch refs/heads/${target.name}`))
          throw new ConflictException('GIT_BRANCH_ACTIVE');
        const base = (
          await this.git.git(
            cwd,
            ['merge-base', state.head, target.revision],
            {},
            15000,
            [0, 1],
          )
        ).trim();
        if (base !== target.revision)
          throw new ConflictException('GIT_BRANCH_UNMERGED');
        await clean();
        // Disable upstream resolution for this command only: branch -d must
        // check HEAD, not a configured upstream (merge is a multi-valued key).
        // An unconfigured random remote has no fetch mapping and cannot resolve
        // an upstream. This command does not contact a remote or edit config.
        // Git also refuses deletion if checked out in ANY linked worktree.
        await this.git.git(cwd, ['branch', '--delete', '--', target.name], {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `branch.${target.name}.remote`,
          GIT_CONFIG_VALUE_0: `mergeron-delete-${randomUUID()}`,
        });
        this.audit(projectId, copyId, 'git_local_delete', {
          branch: target.name,
          sha: target.revision,
          mergedInto: state.branch,
        });
        return {
          branch: state.branch,
          sha: state.head,
          deleted: target.name,
        };
      }
      let revision = target.revision;
      if (body.action === 'merge') {
        const base = (
          await this.git.git(
            cwd,
            ['merge-base', state.head, target.revision],
            {},
            15000,
            [0, 1],
          )
        ).trim();
        if (base === target.revision)
          return { branch: state.branch, sha: state.head };
        if (base !== state.head) {
          // Never run repository-defined merge programs. Compute the result without
          // touching the index/worktree; conflicts therefore leave no partial merge.
          if (
            (
              await this.git.git(
                cwd,
                [
                  'config',
                  '--name-only',
                  '--get-regexp',
                  '^merge\\..*\\.driver$',
                ],
                {},
                15000,
                [0, 1],
              )
            ).trim()
          )
            throw new ConflictException('GIT_CUSTOM_MERGE_DRIVER');
          let tree: string;
          try {
            tree = (
              await this.git.git(cwd, [
                'merge-tree',
                '--write-tree',
                state.head,
                target.revision,
              ])
            ).trim();
          } catch {
            throw new ConflictException('GIT_LOCAL_MERGE_CONFLICT');
          }
          if (!/^[a-f0-9]{40,64}$/.test(tree))
            throw new ConflictException('GIT_LOCAL_MERGE_CONFLICT');
          const access = currentAccess();
          const person =
            access?.identity.kind === 'person' && access.identity.personId
              ? access.identities.resolvePerson(access.identity.personId)
              : undefined;
          const name = person?.name?.trim() ?? '';
          const email = person?.email?.trim() ?? '';
          if (
            person?.kind !== 'person' ||
            !person.personId ||
            !person?.active ||
            !name ||
            name.length > 120 ||
            email.length > 254 ||
            /[<>]/.test(name + email) ||
            [...name, ...email].some(
              (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
            ) ||
            !/^[^\s<>@]+@[^\s<>@]+$/.test(email)
          )
            throw new BadRequestException('GIT_IDENTITY_REQUIRED');
          revision = (
            await this.git.git(
              cwd,
              ['commit-tree', tree, '-p', state.head, '-p', target.revision],
              {
                GIT_AUTHOR_NAME: name,
                GIT_AUTHOR_EMAIL: email,
                GIT_COMMITTER_NAME: name,
                GIT_COMMITTER_EMAIL: email,
              },
              15000,
              [0],
              Buffer.from(`Merge ${target.name} into ${state.branch}\n`),
            )
          ).trim();
        }
      }
      await clean();
      preparer?.assertActive();
      await this.git.git(
        cwd,
        body.action === 'switch'
          ? ['switch', '--no-guess', '--no-overwrite-ignore', target.name]
          : ['merge', '--ff-only', '--no-overwrite-ignore', revision],
      );
      this.audit(projectId, copyId, `git_local_${String(body.action)}`, {
        from: state.branch,
        source: target.name,
        sha: revision,
      });
      return {
        branch: body.action === 'switch' ? target.name : state.branch,
        sha: revision,
      };
    });
  }

  /** Fetch a pinned remote tip, then integrate only into the reviewed local state.
   * Each phase holds the copy lock. A changed HEAD/index is rejected by the
   * original fingerprint and pending edits by the clean-worktree check; no freshly observed state is silently adopted.
   */
  async integrateBranch(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
  ) {
    requireExecutionAccess();
    this.body(body);
    if (body.confirmation !== 'INTEGRATE_REMOTE_BRANCH')
      throw new BadRequestException('GIT_INVALID_INPUT');
    const fetched = await this.retrieveBranch(
      projectId,
      copyId,
      { ...body, confirmation: 'RETRIEVE_REMOTE_BRANCH' },
      undefined,
      true,
      true,
    );
    return this.localBranchAction(
      projectId,
      copyId,
      {
        ...body,
        action: 'merge',
        name: `mergeron/${fetched.branch}`,
        revision: fetched.sha,
        confirmation: 'LOCAL_BRANCH_ACTION',
      },
      undefined,
      true,
    );
  }

  /** Start from a clean worktree; conflicts are a confirmed, inspectable result. */
  async startMerge(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    preparer?: AgentGitPreparer,
  ) {
    this.body(body);
    if (
      typeof body.revision !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(body.revision)
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    return this.localPreparation(
      { projectId, copyId },
      preparer,
      body,
      async () => {
        this.assertCopyAgent(projectId, copyId, body);
        const { cwd, state } = await this.copyState(
          projectId,
          copyId,
          body.fingerprint,
        );
        if (
          state.changes.length ||
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
        const target = body.revision as string;
        if (
          (
            await this.git.git(cwd, [
              'rev-parse',
              '--verify',
              `${target}^{commit}`,
            ])
          ).trim() !== target
        )
          throw new ConflictException('GIT_STALE');
        if (
          (
            await this.git.git(
              cwd,
              [
                'config',
                '--name-only',
                '--get-regexp',
                '^merge\\..*\\.driver$',
              ],
              {},
              15000,
              [0, 1],
            )
          ).trim()
        )
          throw new ConflictException('GIT_CUSTOM_MERGE_DRIVER');
        // ort can replace ignored files even with --no-overwrite-ignore.
        // Check incoming tracked paths against ignored files/directories explicitly.
        const ignored = (
          await this.git.git(cwd, [
            'ls-files',
            '--others',
            '--ignored',
            '--exclude-standard',
            '--directory',
            '-z',
          ])
        )
          .split('\0')
          .filter(Boolean)
          .map((entry) => entry.replace(/\/$/, ''));
        if (ignored.length) {
          const incoming = (
            await this.git.git(cwd, [
              'ls-tree',
              '-r',
              '-z',
              '--name-only',
              target,
            ])
          )
            .split('\0')
            .filter(Boolean);
          if (
            incoming.some((name) =>
              ignored.some(
                (entry) =>
                  name === entry ||
                  name.startsWith(entry + '/') ||
                  entry.startsWith(name + '/'),
              ),
            )
          )
            throw new ConflictException('GIT_WORKTREE_DIRTY');
        }
        await this.copyState(projectId, copyId, body.fingerprint);
        const { authorName, authorEmail } = this.commitIdentity();
        preparer?.assertActive();
        await this.git.git(
          cwd,
          [
            '-c',
            'merge.autoStash=false',
            '-c',
            'rerere.enabled=false',
            '-c',
            'merge.verifySignatures=false',
            '-c',
            'submodule.recurse=false',
            'merge',
            '--no-commit',
            '--no-ff',
            '--no-edit',
            '--no-overwrite-ignore',
            '--strategy=ort',
            target,
          ],
          {
            GIT_AUTHOR_NAME: authorName,
            GIT_AUTHOR_EMAIL: authorEmail,
            GIT_COMMITTER_NAME: authorName,
            GIT_COMMITTER_EMAIL: authorEmail,
          },
          60000,
          [0, 1],
        );
        const result = await this.git.mergeStatus(projectId, copyId);
        if (result.mergeHead !== target && result.mergeHead !== null)
          throw new ConflictException('GIT_MERGE_STATE_UNSUPPORTED');
        if (
          !result.mergeHead &&
          (
            await this.git.git(
              cwd,
              ['merge-base', state.head, target],
              {},
              15000,
              [0, 1],
            )
          ).trim() !== target
        )
          throw new ConflictException('GIT_OPERATION_FAILED');
        this.audit(projectId, copyId, 'git_merge_started', {
          target,
          conflicts: result.conflicts.length,
        });
        return result;
      },
    );
  }

  /** Explicitly discards edits made since the clean merge start; never abort another sequencer. */
  async abortMerge(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    preparer?: AgentGitPreparer,
  ) {
    this.body(body);
    return this.localPreparation(
      { projectId, copyId },
      preparer,
      body,
      async () => {
        this.assertCopyAgent(projectId, copyId, body);
        const { cwd } = await this.copyState(
          projectId,
          copyId,
          body.fingerprint,
          true,
        );
        const state = await this.git.mergeStatus(projectId, copyId);
        if (!state.mergeHead || state.mergeHead !== body.revision)
          throw new ConflictException('GIT_STALE');
        preparer?.assertActive();
        await this.git.git(cwd, [
          '-c',
          'merge.autoStash=false',
          'merge',
          '--abort',
        ]);
        this.audit(projectId, copyId, 'git_merge_aborted', {
          target: state.mergeHead,
        });
        return this.git.mergeStatus(projectId, copyId);
      },
    );
  }

  private async copyState(
    projectId: string,
    copyId: string,
    fingerprint: unknown,
    allowMerge = false,
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
      ...(allowMerge ? [] : ['MERGE_HEAD']),
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'BISECT_START',
    ]) {
      if (await lstat(path.join(cwd, '.git', entry)).catch(() => null))
        throw new ConflictException('GIT_IN_PROGRESS');
    }
    return { copy, source, cwd, state, branch: state.branch };
  }

  private commitIdentity() {
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
    return { authorName, authorEmail };
  }

  async commit(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    preparer?: AgentGitPreparer,
  ) {
    requireExecutionAccess();
    this.body(body);
    const { authorName, authorEmail } = this.commitIdentity();
    const copy = { projectId, copyId };
    return this.localPreparation(copy, preparer, body, async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { cwd, state, branch } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
        body.mergeRevision !== undefined,
      );
      const merge =
        body.mergeRevision === undefined
          ? null
          : await this.git.mergeStatus(projectId, copyId);
      if (
        merge &&
        (merge.mergeHead !== body.mergeRevision || merge.conflicts.length)
      )
        throw new ConflictException('GIT_MERGE_UNRESOLVED');
      const message = this.text(body.message, 4000);
      if (
        !merge &&
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
        preparer?.assertActive();
        const sha = (
          await this.git.git(
            cwd,
            [
              '-c',
              'commit.gpgsign=false',
              'commit-tree',
              tree,
              ...(state.head ? ['-p', state.head] : []),
              ...(merge?.mergeHead ? ['-p', merge.mergeHead] : []),
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
        await this.copyState(projectId, copyId, body.fingerprint, !!merge);
        if (
          merge &&
          (await this.git.mergeStatus(projectId, copyId)).mergeHead !==
            merge.mergeHead
        )
          throw new ConflictException('GIT_STALE');
        preparer?.assertActive();
        await this.git.git(cwd, [
          'update-ref',
          '-m',
          'Mergeron: commit confirmed staged changes',
          `refs/heads/${branch}`,
          sha,
          state.head || '0'.repeat(sha.length),
        ]);
        if (merge) await this.git.git(cwd, ['merge', '--quit']);
        this.audit(projectId, copyId, 'git_commit', {
          branch,
          sha,
          ...(merge ? { mergeHead: merge.mergeHead } : {}),
        });
        return { sha, branch };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

  private async localPreparation<T>(
    copy: { projectId: string; copyId: string },
    preparer: AgentGitPreparer | undefined,
    body: Record<string, unknown>,
    operation: () => Promise<T>,
  ) {
    const { projectId, copyId } = copy;
    if (!preparer) return this.gate.mutate(operation);
    if (body.agentThreadId !== preparer.threadId)
      throw new ForbiddenException('GIT_COPY_OWNED');
    requireThreadAccess(preparer.threadId);
    preparer.assertActive();
    this.assertCopyAgent(projectId, copyId, body);
    const scope = this.gate.hasIsolation(preparer.threadId)
      ? { copyPath: await this.git.directory(projectId, copyId) }
      : undefined;
    return this.gate.mutateFromAgent(
      preparer.threadId,
      async () => {
        preparer.assertActive();
        return operation();
      },
      scope,
    );
  }

  private async remotePublication<T>(
    copy: { projectId: string; copyId: string; pullRequestNumber?: number },
    publisher: AgentGitPublisher | undefined,
    body: Record<string, unknown>,
    operation: () => Promise<T>,
  ) {
    const { projectId, copyId } = copy;
    if (!publisher) return this.gate.mutate(operation);
    if (body.agentThreadId !== publisher.threadId)
      throw new ForbiddenException('GIT_COPY_OWNED');
    requireThreadAccess(publisher.threadId);
    publisher.assertActive();
    this.assertCopyAgent(projectId, copyId, body);
    let scope: { copyPath: string; remoteRef: string } | undefined;
    if (this.gate.hasIsolation(publisher.threadId)) {
      const { cwd, source, branch } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      // Lock the destination ref (or the retargeted PR), not the connection:
      // distinct publications can proceed, but two base changes must serialize.
      scope = {
        copyPath: cwd,
        remoteRef: JSON.stringify(
          copy.pullRequestNumber === undefined
            ? [source.resource.address, branch]
            : [source.resource.address, 'pull_request', copy.pullRequestNumber],
        ),
      };
    }
    return this.gate.publishFromAgent(
      publisher.threadId,
      async () => {
        publisher.assertActive();
        return operation();
      },
      scope,
    );
  }

  async push(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    publisher?: AgentGitPublisher,
  ) {
    requireExecutionAccess();
    this.body(body);
    const copy = { projectId, copyId };
    return this.remotePublication(copy, publisher, body, async () => {
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
        if (
          (current.source.secret?.token || current.source.secret?.password) !==
          env.MERGERON_GIT_TOKEN
        )
          throw new ConflictException('GIT_STALE');
        publisher?.assertActive();
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
        this.audit(projectId, copyId, 'git_push', {
          branch,
          sha: state.head,
        });
        return { sha: state.head, branch };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

  /** Edit only the title and description of an observed PR of this exact copy branch. */
  async updatePullRequest(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    publisher?: AgentGitPublisher,
  ) {
    this.body(body);
    const title = this.text(body.title, 256);
    if (
      typeof body.description !== 'string' ||
      body.description.length > 10000 ||
      !Number.isSafeInteger(body.number) ||
      Number(body.number) < 1 ||
      Number(body.number) > 999999999 ||
      typeof body.expectedUpdatedAt !== 'string' ||
      !Number.isFinite(Date.parse(body.expectedUpdatedAt))
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    return this.remotePublication(
      { projectId, copyId, pullRequestNumber: Number(body.number) },
      publisher,
      body,
      async () => {
        this.assertCopyAgent(projectId, copyId, body);
        const { copy, source, state, branch } = await this.copyState(
          projectId,
          copyId,
          body.fingerprint,
        );
        if (
          body.address !== source.resource.address ||
          body.head !== state.head
        )
          throw new ConflictException('GIT_STALE');
        const repo = this.git.github(projectId, copy.sourceResourceId);
        if (!repo?.token)
          throw new ForbiddenException('GIT_GITHUB_TOKEN_REQUIRED');
        const observed = await this.git.pullRequest(
          projectId,
          copy.sourceResourceId,
          String(body.number),
        );
        if (
          !observed.sameRepository ||
          observed.branch !== branch ||
          observed.head !== state.head ||
          observed.state !== 'open' ||
          observed.updatedAt !== body.expectedUpdatedAt
        )
          throw new ConflictException('GIT_STALE');
        const current = await this.copyState(
          projectId,
          copyId,
          body.fingerprint,
        );
        if (
          current.source.resource.address !== body.address ||
          this.git.github(projectId, copy.sourceResourceId)?.token !==
            repo.token
        )
          throw new ConflictException('GIT_STALE');
        publisher?.assertActive();
        let response: Response;
        try {
          response = await fetch(
            `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${body.number as number}`,
            {
              method: 'PATCH',
              redirect: 'error',
              signal: AbortSignal.timeout(20000),
              headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                Authorization: `Bearer ${repo.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ title, body: body.description }),
            },
          );
        } catch {
          throw new ConflictException('GIT_OUTCOME_UNKNOWN');
        }
        if (!response.ok)
          throw new ConflictException(
            response.status >= 500
              ? 'GIT_OUTCOME_UNKNOWN'
              : 'GIT_PR_UPDATE_FAILED',
          );
        try {
          const updated = (await response.json()) as {
            number: number;
            title: string;
            body: string;
            state: string;
            head: {
              sha: string;
              ref: string;
              repo: { full_name: string } | null;
            };
          };
          if (
            updated.number !== body.number ||
            updated.title !== title ||
            (updated.body ?? '') !== body.description ||
            updated.state !== 'open' ||
            updated.head?.sha !== state.head ||
            updated.head.ref !== branch ||
            updated.head.repo?.full_name?.toLowerCase() !==
              `${repo.owner}/${repo.repo}`.toLowerCase()
          )
            throw Error();
        } catch {
          throw new ConflictException('GIT_OUTCOME_UNKNOWN');
        }
        this.audit(projectId, copyId, 'git_pr_updated', {
          number: body.number,
          branch,
          head: state.head,
        });
        return { number: body.number, url: observed.url, updated: true };
      },
    );
  }

  async createPullRequest(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    publisher?: AgentGitPublisher,
  ) {
    requireExecutionAccess();
    this.body(body);
    const pr = this.pullRequestInput(body, 'CREATE_PULL_REQUEST');
    const copy = { projectId, copyId };
    return this.remotePublication(copy, publisher, body, async () => {
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
      publisher?.assertActive();
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
      publisher?.assertActive();
      return this.postPullRequest(
        projectId,
        copyId,
        repo,
        pr,
        branch,
        state.head,
      );
    });
  }

  /** Change only the base of an existing, same-repository GitHub PR. */
  async retargetPullRequest(
    projectId: string,
    copyId: string,
    body: Record<string, unknown>,
    publisher?: AgentGitPublisher,
  ) {
    requireExecutionAccess();
    this.body(body);
    if (
      body.confirmation !== 'RETARGET_PULL_REQUEST' ||
      !Number.isSafeInteger(body.number) ||
      Number(body.number) < 1 ||
      Number(body.number) > 999999999 ||
      typeof body.base !== 'string' ||
      !body.base ||
      body.base.length > 200 ||
      body.base.startsWith('-') ||
      typeof body.expectedBase !== 'string' ||
      !body.expectedBase ||
      body.expectedBase.length > 200 ||
      typeof body.expectedPullRequestHead !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(body.expectedPullRequestHead)
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    const number = Number(body.number),
      base = body.base,
      expectedBase = body.expectedBase;
    const expectedHead = body.expectedPullRequestHead;
    const copy = { projectId, copyId, pullRequestNumber: number };
    return this.remotePublication(copy, publisher, body, async () => {
      this.assertCopyAgent(projectId, copyId, body);
      const { copy, source, cwd, state } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      if (body.head !== state.head || body.address !== source.resource.address)
        throw new ConflictException('GIT_STALE');
      try {
        if (
          (
            await this.git.git(cwd, ['check-ref-format', '--branch', base])
          ).trim() !== base
        )
          throw Error();
      } catch {
        throw new BadRequestException('GIT_INVALID_INPUT');
      }
      const repo = this.git.github(projectId, copy.sourceResourceId);
      if (!repo?.token)
        throw new ForbiddenException('GIT_GITHUB_TOKEN_REQUIRED');
      const fullName = `${repo.owner}/${repo.repo}`.toLowerCase();
      const endpoint = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${number}`;
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${repo.token}`,
        'Content-Type': 'application/json',
      };
      type PullRequest = {
        number: number;
        state: string;
        merged: boolean;
        head: { ref: string; sha: string; repo: { full_name: string } | null };
        base: { ref: string; repo: { full_name: string } | null };
      };
      let current: PullRequest;
      try {
        const response = await fetch(endpoint, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw Error();
        current = (await response.json()) as PullRequest;
      } catch {
        throw new ConflictException('GIT_PR_READ_FAILED');
      }
      const sameRepository = (pr: PullRequest) =>
        pr?.number === number &&
        pr.base?.repo?.full_name?.toLowerCase() === fullName &&
        pr.head?.repo?.full_name?.toLowerCase() === fullName;
      if (!sameRepository(current))
        throw new ForbiddenException('GIT_PR_REPOSITORY_MISMATCH');
      if (current.state !== 'open' || current.merged !== false)
        throw new ConflictException('GIT_PR_NOT_OPEN');
      if (
        current.head.sha !== expectedHead ||
        current.base.ref !== expectedBase
      )
        throw new ConflictException('GIT_STALE');
      if (base === current.head.ref)
        throw new BadRequestException('GIT_PR_SAME_BRANCH');
      const fresh = await this.copyState(projectId, copyId, body.fingerprint);
      if (
        fresh.state.head !== state.head ||
        fresh.source.resource.address !== body.address ||
        this.git.github(projectId, copy.sourceResourceId)?.token !== repo.token
      )
        throw new ConflictException('GIT_STALE');
      publisher?.assertActive();
      const url = `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`;
      if (base === expectedBase)
        return { number, url, base, head: expectedHead, unchanged: true };
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'PATCH',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ base }),
        });
      } catch {
        throw new ConflictException('GIT_OUTCOME_UNKNOWN');
      }
      if (!response.ok)
        throw new ConflictException(
          response.status >= 500
            ? 'GIT_OUTCOME_UNKNOWN'
            : 'GIT_PR_RETARGET_FAILED',
        );
      try {
        const updated = (await response.json()) as PullRequest;
        if (
          !sameRepository(updated) ||
          updated.state !== 'open' ||
          updated.merged !== false ||
          updated.base.ref !== base ||
          updated.head.sha !== expectedHead
        )
          throw Error();
      } catch {
        throw new ConflictException('GIT_OUTCOME_UNKNOWN');
      }
      this.audit(projectId, copyId, 'git_pr_retargeted', {
        number,
        previousBase: expectedBase,
        base,
        head: expectedHead,
      });
      return { number, url, base, head: expectedHead, unchanged: false };
    });
  }

  async createRemotePullRequest(
    projectId: string,
    resourceId: string,
    body: Record<string, unknown>,
  ) {
    requireExecutionAccess();
    this.body(body);
    const pr = this.pullRequestInput(body, 'CREATE_REMOTE_PULL_REQUEST');
    if (
      typeof body.branch !== 'string' ||
      !body.branch ||
      body.branch.length > 200 ||
      body.branch.startsWith('-') ||
      [...body.branch, ...pr.base].some(
        (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127,
      ) ||
      typeof body.head !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(body.head)
    )
      throw new BadRequestException('GIT_INVALID_INPUT');
    const branch = body.branch;
    if (branch === pr.base) throw new BadRequestException('GIT_PR_SAME_BRANCH');
    return this.gate.mutate(async () => {
      const source = this.writable(projectId, resourceId);
      if (source.resource.address !== body.address)
        throw new ConflictException('GIT_STALE');
      const repo = this.git.github(projectId, resourceId);
      if (!repo?.token)
        throw new ForbiddenException('GIT_GITHUB_TOKEN_REQUIRED');
      // GitHub is the authority here. No copy, local branch, push receipt,
      // index, worktree or agent workspace is needed or touched.
      const prepared = await this.git.pullRequestPreparation(
        projectId,
        resourceId,
        branch,
        pr.base,
      );
      if (prepared.head !== body.head) throw new ConflictException('GIT_STALE');
      const current = this.writable(projectId, resourceId);
      if (
        current.resource.address !== body.address ||
        this.git.github(projectId, resourceId)?.token !== repo.token
      )
        throw new ConflictException('GIT_STALE');
      if (prepared.existingNumber)
        return {
          number: prepared.existingNumber,
          url: `https://github.com/${repo.owner}/${repo.repo}/pull/${prepared.existingNumber}`,
          existing: true,
        };
      return this.postPullRequest(
        projectId,
        resourceId,
        repo,
        pr,
        branch,
        body.head,
      );
    });
  }

  private pullRequestInput(
    body: Record<string, unknown>,
    confirmation: string,
  ) {
    if (
      body.confirmation !== confirmation ||
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
    return {
      title: body.title.trim(),
      base: body.base,
      description: body.description,
      draft: body.draft,
    };
  }

  private async postPullRequest(
    projectId: string,
    auditId: string,
    repo: NonNullable<ReturnType<WorkspaceGitService['github']>>,
    pr: { title: string; description: string; base: string; draft: boolean },
    branch: string,
    head: string,
  ) {
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
        response.status >= 500 ? 'GIT_OUTCOME_UNKNOWN' : 'GIT_PR_CREATE_FAILED',
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
    this.audit(projectId, auditId, 'git_pr_created', {
      number: result.number,
      branch,
      base: pr.base,
      head,
      draft: pr.draft,
    });
    return {
      number: result.number,
      url: `https://github.com/${repo.owner}/${repo.repo}/pull/${result.number}`,
      existing: false,
    };
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
          (
            {
              git_stage: 'Préparation de fichiers pour un commit',
              git_unstage: 'Retrait de fichiers du prochain commit',
              git_commit: 'Commit Git',
              git_push: 'Push Git',
              git_branch_created: 'Création de branche Git locale',
              git_remote_branch_retrieved:
                'Récupération de branche Git distante',
              git_local_switch: 'Changement de branche Git locale',
              git_local_merge: 'Fusion de branches Git locales',
              git_local_delete: 'Suppression de branche Git locale',
              git_merge_started: 'Préparation de fusion Git locale',
              git_merge_aborted: 'Annulation de fusion Git locale',
              git_pr_created: 'Création de pull request',
              git_pr_updated: 'Modification de pull request',
              git_pr_retargeted: 'Changement de cible de pull request',
              git_pr_merged: 'Fusion de pull request',
            } as Record<string, string>
          )[action] ?? 'Opération Git',
        details,
        actorPersonId: identity?.personId ?? null,
        actorName: identity?.name ?? 'Système',
        createdAt: Date.now(),
      })
      .run();
  }
}
