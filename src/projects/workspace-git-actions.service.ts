import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentAccess, requireExecutionAccess } from '../auth/access-context';
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
    return this.gate.mutate(async () => {
      const { cwd, state, branch } = await this.copyState(
        projectId,
        copyId,
        body.fingerprint,
      );
      const message = this.text(body.message, 4000);
      const name = this.text(body.authorName, 120);
      const email = this.text(body.authorEmail, 254);
      if (/[<>\r\n]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email))
        throw new BadRequestException('GIT_IDENTITY_REQUIRED');
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
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
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
          action === 'git_commit'
            ? 'Commit Git'
            : action === 'git_push'
              ? 'Push Git'
              : 'Fusion de pull request',
        details,
        actorPersonId: identity?.personId ?? null,
        actorName: identity?.name ?? 'Système',
        createdAt: Date.now(),
      })
      .run();
  }
}
