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
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import {
  listProjectConnectionsInput,
  readProjectGitInput,
  publishProjectGitInput,
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
                    ...(root.accessMode === 'read_write' &&
                    root.capabilities.write
                      ? ['publish_project_git']
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
    const publishing = tool === 'publish_project_git';
    if (!publishing && tool !== 'read_project_git')
      throw new BadRequestException('Invalid connection tool');
    const args = publishing
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
    if (!publishing) {
      const read = readProjectGitInput.parse(raw);
      const local = read.operation.startsWith('local_');
      const allowed = [
        'connectionId',
        'operation',
        ...(local ? ['copyId'] : []),
        ...(['files', 'local_diff'].includes(read.operation) ? ['path'] : []),
        ...(read.operation === 'files' ? ['ref'] : []),
        ...(read.operation === 'checks' ? ['number'] : []),
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
        case 'checks':
          if (!read.number)
            throw new BadRequestException('A pull request number is required');
          data = await this.git.checks(
            projectId,
            connection.id,
            String(read.number),
          );
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
    const publish = publishProjectGitInput.parse(raw);
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
      ['base', 'title', 'description', 'draft'].some((k) =>
        Object.hasOwn(raw, k),
      )
    )
      throw new BadRequestException('Invalid push fields');
    if (
      publish.operation === 'create_pull_request' &&
      (!publish.base || !publish.title || publish.draft === undefined)
    )
      throw new BadRequestException('Pull request fields are required');
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
      base: publish.base,
      title: publish.title,
      description: publish.description ?? '',
      draft: publish.draft,
      confirmation: 'CREATE_PULL_REQUEST',
    };
    const publisher = { threadId, assertActive: assertWrite };
    const data =
      publish.operation === 'push'
        ? await this.actions.push(projectId, publish.copyId, body, publisher)
        : await this.actions.createPullRequest(
            projectId,
            publish.copyId,
            body,
            publisher,
          );
    // Once dispatched, record a confirmed outcome even if the turn ended while waiting.
    const result = {
      connectionId: connection.id,
      operation: publish.operation,
      data,
    };
    this.db.update(projectAgentToolRequests).set({ result }).where(key).run();
    this.db
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        action: 'agent_connection_published',
        entityType: 'agent',
        entityId: threadId,
        label: publish.operation,
        details: {
          requestId: publish.requestId,
          userRequest: publish.userRequest,
          connectionId: connection.id,
          copyId: publish.copyId,
          head: publish.expectedHead,
        },
        actorPersonId: access.identity.personId,
        actorName: access.identity.name ?? 'Agent',
        createdAt: Date.now(),
      })
      .run();
    return result;
  }
}
