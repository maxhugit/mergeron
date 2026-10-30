import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import {
  currentAccess,
  requireProjectAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectActivity,
  projectAgentThreads,
  projectAgentToolRequests,
} from '../database/schema';
import { ProjectLocationsService } from './project-locations.service';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceGitService } from './workspace-git.service';
import { GitGateRefusal } from '../threads/git-mutation-gate.service';
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import {
  listProjectConnectionsInput,
  createProjectGitCopyInput,
  readProjectGitInput,
  publishProjectGitInput,
  prepareProjectGitOperationInput,
} from './project-connection-tools.schema';

/** Bound project operations; no credential, arbitrary host, shell or local-path argument. */
@Injectable()
export class ProjectConnectionToolsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly locations: ProjectLocationsService,
    private readonly copies: WorkspaceCopiesService,
    private readonly git: WorkspaceGitService,
    private readonly actions: WorkspaceGitActionsService,
  ) {}

  async execute(
    projectId: string,
    threadId: string,
    input: Record<string, unknown>,
    assertActive: () => void,
  ) {
    const check = () => {
      assertActive();
      const access = currentAccess();
      if (!access) throw new ForbiddenException('ACCESS_DENIED');
      access.identities.requireActive(access.identity);
      requireThreadAccess(threadId);
      requireProjectAccess(projectId);
      const binding = this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, threadId))
        .get();
      if (binding?.projectId !== projectId)
        throw new ForbiddenException('ACCESS_DENIED');
      return access;
    };
    check();
    const { tool, ...raw } = input;
    if (tool === 'list_project_connections') {
      const args = listProjectConnectionsInput.parse(raw);
      const inventory = this.locations.list(projectId);
      const all = inventory.connections
        .filter(
          (c) =>
            !args.query ||
            c.name.toLocaleLowerCase().includes(args.query.toLocaleLowerCase()),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const offset = args.offset ?? 0;
      const copies = this.copies.list(projectId);
      return {
        items: all.slice(offset, offset + 50).map((c) => {
          const root = inventory.locations.find(
            (l) => l.connectionId === c.id && l.kind === 'remote',
          );
          return {
            id: c.id,
            name: c.name,
            protocol: c.protocol,
            enabled: c.enabled,
            connectionState: c.connectionState,
            accessMode: root?.accessMode ?? 'read_only',
            hasSecret: c.hasSecret,
            // Endpoints and raw lastError are intentionally not returned.
            operations:
              c.enabled && root?.capabilities.read && c.protocol === 'git'
                ? [
                    'read_project_git',
                    'create_project_git_copy',
                    ...(root.accessMode === 'read_write' &&
                    root.capabilities.write
                      ? ['prepare_project_git', 'publish_project_git']
                      : []),
                  ]
                : [],
            copies: copies
              .filter(
                (copy) =>
                  copy.sourceResourceId === c.id &&
                  copy.ownerThreadIds.includes(threadId),
              )
              .map((copy) => ({
                id: copy.id,
                state: copy.state,
                branch: copy.branch,
                revision: copy.revision,
                localPath: copy.localPath,
              })),
          };
        }),
        total: all.length,
        nextOffset: offset + 50 < all.length ? offset + 50 : null,
        untrustedContent: true,
      };
    }
    if (tool === 'create_project_git_copy') {
      const args = createProjectGitCopyInput.parse(raw);
      const assertCreate = () => {
        const access = check();
        access.identities.requireAdministrator(access.identity);
        if (access.identity.impersonation)
          throw new ForbiddenException('ACCESS_DENIED');
        const inventory = this.locations.list(projectId);
        const connection = inventory.connections.find(
          (c) => c.id === args.connectionId,
        );
        const root = inventory.locations.find(
          (l) => l.connectionId === args.connectionId && l.kind === 'remote',
        );
        if (
          !connection?.enabled ||
          connection.protocol !== 'git' ||
          !root?.capabilities.read
        )
          throw new ForbiddenException('PROJECT_CONNECTION_UNAVAILABLE');
        return access;
      };
      const observed = this.locations
        .list(projectId)
        .connections.find((connection) => connection.id === args.connectionId);
      const beforeCommit = () => {
        assertCreate();
        const latest = this.locations
          .list(projectId)
          .connections.find(
            (connection) => connection.id === args.connectionId,
          );
        if (
          !observed ||
          latest?.updatedAt !== observed.updatedAt ||
          latest?.address !== observed.address
        )
          throw new ForbiddenException('PROJECT_CONNECTION_UNAVAILABLE');
      };
      const access = assertCreate();
      const key = and(
        eq(projectAgentToolRequests.projectId, projectId),
        eq(projectAgentToolRequests.threadId, threadId),
        eq(projectAgentToolRequests.requestId, args.requestId),
      );
      const digest = createHash('sha256')
        .update(JSON.stringify({ tool, ...args }))
        .digest('hex');
      const previous = this.db
        .select()
        .from(projectAgentToolRequests)
        .where(key)
        .get();
      if (previous) {
        if (
          previous.digest !== digest ||
          previous.personId !== access.identity.personId
        )
          throw new ConflictException('PROJECT_CONNECTION_REQUEST_CONFLICT');
        if (!previous.result)
          throw new ConflictException('GIT_OUTCOME_UNKNOWN');
        // Never return a stale success after ownership was released or revoked.
        const copy = this.copies
          .list(projectId)
          .find((copy) => copy.id === previous.result?.id);
        if (!copy?.ownerThreadIds.includes(threadId) || copy.state !== 'ready')
          throw new ForbiddenException('GIT_COPY_OWNED');
        return previous.result;
      }
      const owned = this.copies
        .list(projectId)
        .filter((copy) => copy.ownerThreadIds.includes(threadId));
      if (owned.length) throw new ConflictException('GIT_AGENT_COPY_EXISTS');
      this.db
        .insert(projectAgentToolRequests)
        .values({
          projectId,
          threadId,
          requestId: args.requestId,
          digest,
          personId: access.identity.personId,
          createdAt: Date.now(),
        })
        .run();
      const copy = await this.copies.create(
        projectId,
        args.connectionId,
        {
          branch: args.branch,
          agentThreadId: threadId,
        },
        beforeCommit,
      );
      const result = {
        id: copy.id,
        connectionId: args.connectionId,
        ownerThreadId: threadId,
        localPath: copy.localPath,
        branch: copy.branch,
        revision: copy.revision,
        state: copy.state,
        // Ownership is independent of the human's active-folder selection.
        activeFolderChanged: false,
      };
      this.db.update(projectAgentToolRequests).set({ result }).where(key).run();
      return result;
    }
    const publishing = tool === 'publish_project_git';
    const preparing = tool === 'prepare_project_git';
    if (!publishing && !preparing && tool !== 'read_project_git')
      throw new BadRequestException('Invalid connection tool');
    const args = preparing
      ? prepareProjectGitOperationInput.parse(raw)
      : publishing
        ? publishProjectGitInput.parse(raw)
        : readProjectGitInput.parse(raw);
    const inventory = this.locations.list(projectId);
    const connection = inventory.connections.find(
      (c) => c.id === args.connectionId,
    );
    const root = inventory.locations.find(
      (l) => l.connectionId === args.connectionId && l.kind === 'remote',
    );
    if (!connection || !connection.enabled || !root?.capabilities.read)
      throw new ForbiddenException('PROJECT_CONNECTION_UNAVAILABLE');
    if (connection.protocol !== 'git')
      throw new BadRequestException('PROJECT_CONNECTION_UNSUPPORTED');
    const checkConnection = () => {
      check();
      const current = this.locations.list(projectId);
      const latest = current.connections.find((c) => c.id === connection.id);
      const location = current.locations.find((l) => l.id === root.id);
      if (
        !latest?.enabled ||
        latest.protocol !== 'git' ||
        latest.address !== connection.address ||
        latest.updatedAt !== connection.updatedAt ||
        location?.updatedAt !== root.updatedAt ||
        !location?.capabilities.read
      )
        throw new ForbiddenException('PROJECT_CONNECTION_UNAVAILABLE');
    };
    const ownCopy = (copyId?: string) => {
      const copy = this.copies
        .list(projectId)
        .find(
          (c) =>
            c.id === copyId &&
            c.sourceResourceId === connection.id &&
            c.ownerThreadIds.includes(threadId),
        );
      if (!copy) throw new ForbiddenException('GIT_COPY_OWNED');
      return copy;
    };
    if (!publishing && !preparing) {
      const read = readProjectGitInput.parse(raw);
      const local = read.operation.startsWith('local_');
      const allowed = [
        'connectionId',
        'operation',
        ...(local ? ['copyId'] : []),
        ...([
          'files',
          'local_diff',
          'local_staged_diff',
          'local_conflict',
        ].includes(read.operation)
          ? ['path']
          : []),
        ...(read.operation === 'files' ? ['ref'] : []),
        ...(['checks', 'pull_request'].includes(read.operation)
          ? ['number']
          : []),
      ];
      if (Object.keys(raw).some((k) => !allowed.includes(k)))
        throw new BadRequestException('Invalid operation fields');
      if (local) ownCopy(read.copyId);
      check();
      checkConnection();
      let data: unknown;
      switch (read.operation) {
        case 'branches':
          data = await this.git.remoteBranches(projectId, connection.id);
          break;
        case 'files':
          data = await this.git.remoteFiles(
            projectId,
            connection.id,
            read.path,
            read.ref,
          );
          break;
        case 'pull_requests':
          data = await this.git.pullRequests(projectId, connection.id);
          break;
        case 'pull_request':
          if (!read.number)
            throw new BadRequestException('A pull request number is required');
          data = await this.git.pullRequest(
            projectId,
            connection.id,
            String(read.number),
          );
          break;
        case 'checks':
          if (!read.number)
            throw new BadRequestException('A pull request number is required');
          data = await this.git.checks(
            projectId,
            connection.id,
            String(read.number),
          );
          break;
        case 'local_conflict':
          data = await this.git.conflictFile(
            projectId,
            read.copyId!,
            read.path,
          );
          break;
        case 'local_merge_status':
          data = await this.git.mergeStatus(projectId, read.copyId!);
          break;
        case 'local_status':
          data = await this.git.snapshot(projectId, read.copyId!);
          break;
        case 'local_diff':
          data = await this.git.diff(projectId, read.copyId!, read.path);
          break;
        case 'local_commits':
          data = await this.git.commits(projectId, read.copyId!);
          break;
        case 'local_staged_diff':
          data = await this.git.stagedDiff(projectId, read.copyId!, read.path);
          break;
      }
      checkConnection();
      if (local) ownCopy(read.copyId);
      return {
        connectionId: connection.id,
        operation: read.operation,
        data,
        untrustedContent: true,
      };
    }
    const publish = preparing
      ? prepareProjectGitOperationInput.parse(raw)
      : publishProjectGitInput.parse(raw);
    const assertWrite = () => {
      const access = check();
      access.identities.requireAdministrator(access.identity);
      if (access.identity.impersonation)
        throw new ForbiddenException('ACCESS_DENIED');
      const fresh = this.locations.list(projectId);
      const latest = fresh.connections.find((c) => c.id === connection.id);
      const location = fresh.locations.find((l) => l.id === root.id);
      if (
        !latest?.enabled ||
        latest.protocol !== 'git' ||
        latest.address !== connection.address ||
        latest.updatedAt !== connection.updatedAt ||
        location?.updatedAt !== root.updatedAt ||
        location?.accessMode !== 'read_write' ||
        !location.capabilities.write
      )
        throw new ForbiddenException('GIT_READ_ONLY');
      if (ownCopy(publish.copyId).accessMode !== 'read_write')
        throw new ForbiddenException('GIT_READ_ONLY');
    };
    assertWrite();
    if (
      publish.operation === 'push' &&
      [
        'base',
        'title',
        'description',
        'draft',
        'number',
        'expectedUpdatedAt',
        'expectedBase',
        'expectedPullRequestHead',
      ].some((k) => Object.hasOwn(raw, k))
    )
      throw new BadRequestException('Invalid push fields');
    if (
      publish.operation === 'create_pull_request' &&
      (!publish.base || !publish.title || publish.draft === undefined)
    )
      throw new BadRequestException('Pull request fields are required');
    if (
      publish.operation === 'update_pull_request' &&
      (!publish.number ||
        !publish.title ||
        publish.description === undefined ||
        !publish.expectedUpdatedAt ||
        ['base', 'draft', 'expectedBase', 'expectedPullRequestHead'].some((k) =>
          Object.hasOwn(raw, k),
        ))
    )
      throw new BadRequestException('Pull request update fields are required');
    if (
      publish.operation === 'create_pull_request' &&
      [
        'number',
        'expectedUpdatedAt',
        'expectedBase',
        'expectedPullRequestHead',
      ].some((k) => Object.hasOwn(raw, k))
    )
      throw new BadRequestException('Invalid pull request creation fields');
    if (
      publish.operation === 'retarget_pull_request' &&
      (!publish.number ||
        !publish.base ||
        !publish.expectedBase ||
        !publish.expectedPullRequestHead ||
        ['title', 'description', 'draft', 'expectedUpdatedAt'].some((k) =>
          Object.hasOwn(raw, k),
        ))
    )
      throw new BadRequestException(
        'Pull request retarget fields are required',
      );
    const key = and(
      eq(projectAgentToolRequests.projectId, projectId),
      eq(projectAgentToolRequests.threadId, threadId),
      eq(projectAgentToolRequests.requestId, publish.requestId),
    );
    const access = check();
    const digest = createHash('sha256')
      .update(JSON.stringify({ tool, ...publish }))
      .digest('hex');
    const previous = this.db
      .select()
      .from(projectAgentToolRequests)
      .where(key)
      .get();
    if (previous) {
      if (
        previous.digest !== digest ||
        previous.personId !== access.identity.personId
      )
        throw new ConflictException('PROJECT_CONNECTION_REQUEST_CONFLICT');
      if (!previous.result) throw new ConflictException('GIT_OUTCOME_UNKNOWN');
      return previous.result;
    }
    const state = await this.git.snapshot(projectId, publish.copyId);
    if (
      state.head !== publish.expectedHead ||
      state.branch !== publish.expectedBranch ||
      state.fingerprint !== publish.fingerprint
    )
      throw new ConflictException('GIT_STALE');
    assertWrite();
    this.db
      .insert(projectAgentToolRequests)
      .values({
        projectId,
        threadId,
        requestId: publish.requestId,
        digest,
        personId: access.identity.personId,
        createdAt: Date.now(),
      })
      .run();
    const body = {
      agentThreadId: threadId,
      address: connection.address,
      fingerprint: publish.fingerprint,
      head: publish.expectedHead,
    };
    const publisher = { threadId, assertActive: assertWrite };
    let data: unknown;
    try {
      if (preparing) {
        const local = prepareProjectGitOperationInput.parse(raw);
        switch (local.operation) {
          case 'stage_review':
            data = await this.actions.stageReview(projectId, local.copyId, {
              ...body,
              paths: local.paths,
            });
            assertWrite();
            break;
          case 'stage':
            data = await this.actions.stage(
              projectId,
              local.copyId,
              {
                ...body,
                paths: local.paths,
                reviewFingerprint: local.reviewFingerprint,
              },
              publisher,
            );
            break;
          case 'unstage':
            data = await this.actions.unstage(
              projectId,
              local.copyId,
              { ...body, paths: local.paths },
              publisher,
            );
            break;
          case 'commit':
            data = await this.actions.commit(
              projectId,
              local.copyId,
              { ...body, message: local.message },
              publisher,
            );
            break;
          case 'fetch_branch':
            data = await this.actions.retrieveBranch(
              projectId,
              local.copyId,
              {
                ...body,
                name: local.name,
                revision: local.revision,
                confirmation: 'RETRIEVE_REMOTE_BRANCH',
              },
              publisher,
              true,
            );
            break;
          case 'switch_branch':
            data = await this.actions.localBranchAction(
              projectId,
              local.copyId,
              {
                ...body,
                action: 'switch',
                name: local.name,
                revision: local.revision,
                confirmation: 'LOCAL_BRANCH_ACTION',
              },
              publisher,
            );
            break;
          case 'start_merge':
            data = await this.actions.startMerge(
              projectId,
              local.copyId,
              { ...body, revision: local.revision },
              publisher,
            );
            break;
          case 'continue_merge':
            data = await this.actions.commit(
              projectId,
              local.copyId,
              {
                ...body,
                mergeRevision: local.revision,
                message: local.message,
              },
              publisher,
            );
            break;
          case 'abort_merge':
            data = await this.actions.abortMerge(
              projectId,
              local.copyId,
              { ...body, revision: local.revision },
              publisher,
            );
            break;
          case 'create_branch':
            // Switch only from a clean worktree, at an observed revision. No reset,
            // arbitrary start ref, fetch, force, stash or file restoration.
            data = await this.actions.createBranch(
              projectId,
              local.copyId,
              {
                ...body,
                name: local.name,
                startRef: local.startRef ?? 'HEAD',
                startRevision: local.revision ?? local.expectedHead,
                checkout: true,
                confirmation: 'CREATE_LOCAL_BRANCH',
              },
              publisher,
            );
            break;
        }
      } else {
        const remote = publishProjectGitInput.parse(raw);
        const remoteBody = {
          ...body,
          base: remote.base,
          title: remote.title,
          description: remote.description ?? '',
          draft: remote.draft,
          confirmation: 'CREATE_PULL_REQUEST',
          number: remote.number,
          expectedUpdatedAt: remote.expectedUpdatedAt,
        };
        data =
          remote.operation === 'push'
            ? await this.actions.push(
                projectId,
                remote.copyId,
                remoteBody,
                publisher,
              )
            : remote.operation === 'update_pull_request'
              ? await this.actions.updatePullRequest(
                  projectId,
                  remote.copyId,
                  remoteBody,
                  publisher,
                )
              : remote.operation === 'retarget_pull_request'
                ? await this.actions.retargetPullRequest(
                    projectId,
                    remote.copyId,
                    {
                      ...body,
                      confirmation: 'RETARGET_PULL_REQUEST',
                      number: remote.number,
                      base: remote.base,
                      expectedBase: remote.expectedBase,
                      expectedPullRequestHead: remote.expectedPullRequestHead,
                    },
                    publisher,
                  )
                : await this.actions.createPullRequest(
                    projectId,
                    remote.copyId,
                    remoteBody,
                    publisher,
                  );
      }
    } catch (error) {
      // A gate refusal happens before dispatch. Preserve the stable requestId
      // for a safe retry; an error after dispatch remains outcome-unknown.
      if (error instanceof GitGateRefusal)
        this.db.delete(projectAgentToolRequests).where(key).run();
      throw error;
    }
    // Once dispatched, record a confirmed outcome even if the turn ended while waiting.
    const result = {
      connectionId: connection.id,
      operation: publish.operation,
      data,
      untrustedContent: true,
    };
    this.db.update(projectAgentToolRequests).set({ result }).where(key).run();
    this.db
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        action: preparing ? 'agent_git_prepared' : 'agent_connection_published',
        entityType: 'agent',
        entityId: threadId,
        label: publish.operation,
        details: {
          requestId: publish.requestId,
          userRequest: publish.userRequest,
          connectionId: connection.id,
          copyId: publish.copyId,
          head: publish.expectedHead,
          ...(!preparing && publish.operation === 'retarget_pull_request'
            ? {
                number: publish.number,
                base: publish.base,
                expectedBase: publish.expectedBase,
                expectedPullRequestHead: publish.expectedPullRequestHead,
              }
            : {}),
        },
        actorPersonId: access.identity.personId,
        actorName: access.identity.name ?? 'Agent',
        createdAt: Date.now(),
      })
      .run();
    return result;
  }
}
