import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { mkdir, rm, lstat, realpath, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  currentAccess,
  requireExecutionAccess,
  requireProjectAccess,
} from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectActivity,
  projectWorkspaceCopies,
  projectWorkspaceResources,
  projectWorkspaces,
  projectConnections,
  projectLocations,
  projectActiveFolders,
  projectAgentThreads,
  simpleChatThreads,
  projects,
  type ProjectWorkspaceCopy,
} from '../database/schema';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';

export interface WorkspaceCopyView extends ProjectWorkspaceCopy {
  localPath: string | null;
  sourceName: string | null;
  sourceType: string | null;
  accessMode: 'read_only' | 'read_write' | null;
  sourceEnabled: boolean;
}

/** Creates isolated, explicit local copies of resources for project activities. */
@Injectable()
export class WorkspaceCopiesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly resources: WorkspaceResourcesService,
    @Optional() private readonly gate?: GitMutationGateService,
  ) {}

  list(projectId: string): WorkspaceCopyView[] {
    requireProjectAccess(projectId);
    return this.db
      .select()
      .from(projectWorkspaceCopies)
      .where(eq(projectWorkspaceCopies.projectId, projectId))
      .all()
      .map((copy) => this.view(copy));
  }

  async create(
    projectId: string,
    sourceResourceId: string,
    input: { name?: unknown; branch?: unknown },
  ): Promise<WorkspaceCopyView> {
    requireExecutionAccess();
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project) throw new NotFoundException('Project not found');
    const source = this.resources.get(projectId, sourceResourceId);
    if (source.type !== 'git')
      throw new ConflictException(
        'This remote resource cannot be an execution folder. File transfer copies are handled explicitly by the transfer workflow.',
      );
    const name =
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, 120)
        : `${source.name} — copie`;
    const branch =
      typeof input.branch === 'string' && input.branch.trim()
        ? input.branch.trim()
        : null;
    if (input.branch !== undefined && input.branch !== null && !branch)
      throw new BadRequestException('Invalid Git branch or tag');

    const primary = this.db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.primary, true),
        ),
      )
      .get();
    if (!primary) throw new ConflictException('Primary workspace is missing');
    const id = randomUUID();
    const parent = path.join(
      primary.path,
      'sources',
      '.external',
      sourceResourceId,
    );
    const target = path.join(parent, id);
    await mkdir(parent, { recursive: true });
    try {
      const git = await this.resources.cloneGit(
        projectId,
        sourceResourceId,
        target,
        branch,
      );
      const now = Date.now();
      this.db.transaction((tx) => {
        tx.insert(projectWorkspaces)
          .values({
            id,
            projectId,
            name,
            path: target,
            primary: false,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.insert(projectWorkspaceCopies)
          .values({
            id,
            projectId,
            sourceResourceId,
            localWorkspaceId: id,
            name,
            branch: git.branch,
            revision: git.revision,
            state: 'ready',
            createdAt: now,
            updatedAt: now,
          })
          .run();
        this.insertActivity(tx, projectId, 'workspace_copy_created', id, name, {
          sourceResourceId,
          branch: git.branch,
          revision: git.revision,
          path: target,
        });
      });
      return this.view(
        this.db
          .select()
          .from(projectWorkspaceCopies)
          .where(eq(projectWorkspaceCopies.id, id))
          .get()!,
      );
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remove(
    projectId: string,
    id: string,
    input?: { confirmation?: unknown; path?: unknown },
  ) {
    requireExecutionAccess();
    if (input?.confirmation !== 'REMOVE_WORKING_COPY')
      throw new BadRequestException('GIT_COPY_CONFIRMATION_REQUIRED');
    if (!this.gate) throw new ConflictException('GIT_AGENT_STATE_UNKNOWN');
    return this.gate.mutate(() =>
      this.removeConfirmed(projectId, id, input.path),
    );
  }

  private async removeConfirmed(
    projectId: string,
    id: string,
    expectedPath: unknown,
  ) {
    const copy = this.copy(projectId, id);
    const workspace = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, copy.localWorkspaceId))
      .get();
    if (!workspace) throw new ConflictException('Working copy is detached');
    const primary = this.db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.primary, true),
        ),
      )
      .get();
    if (!primary) throw new ConflictException('Primary workspace is missing');
    const allowed = path.resolve(primary.path, 'sources', '.external');
    const target = path.resolve(workspace.path);
    if (expectedPath !== workspace.path)
      throw new ConflictException('GIT_STALE');
    if (
      workspace.primary ||
      !target.startsWith(allowed + path.sep) ||
      !/^[A-Za-z0-9_-]+$/.test(copy.sourceResourceId) ||
      target !== path.join(allowed, copy.sourceResourceId, copy.id)
    )
      throw new ConflictException('Working copy path is outside its project');
    const root = await realpath(primary.path);
    for (const candidate of [
      path.join(primary.path, 'sources'),
      allowed,
      path.dirname(target),
      target,
    ]) {
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new ConflictException('GIT_COPY_PATH_UNSAFE');
    }
    const canonicalTarget = await realpath(target);
    if (
      canonicalTarget !==
      path.join(root, 'sources', '.external', copy.sourceResourceId, copy.id)
    )
      throw new ConflictException('GIT_COPY_PATH_UNSAFE');
    const contains = (value: string) =>
      value === canonicalTarget || value.startsWith(canonicalTarget + path.sep);
    const folders = this.db.select().from(projectActiveFolders).all();
    const workspaces = this.db.select().from(projectWorkspaces).all();
    const locations = this.db.select().from(projectLocations).all();
    const aliases = new Set([
      copy.id,
      copy.localWorkspaceId,
      `local:${copy.localWorkspaceId}`,
      ...locations
        .filter((row) => row.localWorkspaceId === copy.localWorkspaceId)
        .map((row) => row.id),
    ]);
    if (folders.some((row) => aliases.has(row.resourceId)))
      throw new ConflictException('GIT_COPY_IN_USE');
    const paths = [
      ...this.db
        .select()
        .from(projectAgentThreads)
        .all()
        .map((row) => row.workspacePath),
      ...this.db
        .select()
        .from(simpleChatThreads)
        .all()
        .map((row) => row.cwd),
      ...folders.map((row) => {
        const base =
          workspaces.find(
            (item) =>
              item.id === row.resourceId ||
              `local:${item.id}` === row.resourceId,
          )?.path ??
          locations.find(
            (item) =>
              item.id === row.resourceId ||
              item.legacyResourceId === row.resourceId,
          )?.path;
        return base ? path.resolve(base, row.relativePath) : null;
      }),
    ].filter((value): value is string => Boolean(value));
    for (const value of paths)
      if (contains(await realpath(value).catch(() => path.resolve(value))))
        throw new ConflictException('GIT_COPY_IN_USE');
    const trash = path.join(root, 'sources', '.external', '.trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    if (
      (await lstat(trash)).isSymbolicLink() ||
      (await realpath(trash)) !== trash
    )
      throw new ConflictException('GIT_COPY_PATH_UNSAFE');
    const recoveryPath = path.join(trash, `${copy.id}-${randomUUID()}`);
    await rename(target, recoveryPath);
    try {
      this.db.transaction((tx) => {
        tx.delete(projectWorkspaceResources)
          .where(eq(projectWorkspaceResources.id, copy.localWorkspaceId))
          .run();
        tx.delete(projectWorkspaces)
          .where(eq(projectWorkspaces.id, copy.localWorkspaceId))
          .run();
        this.insertActivity(
          tx,
          projectId,
          'workspace_copy_removed',
          id,
          copy.name,
          {
            sourceResourceId: copy.sourceResourceId,
            path: target,
            remoteDataDeleted: false,
            recoveryPath,
          },
        );
      });
    } catch (error) {
      await rename(recoveryPath, target);
      throw error;
    }
    return {
      ok: true,
      preservedRemote: true,
      activeReferencesPreserved: true,
      recoveryPath,
      preservedLocal: true,
    };
  }

  private copy(projectId: string, id: string): ProjectWorkspaceCopy {
    requireProjectAccess(projectId);
    const copy = this.db
      .select()
      .from(projectWorkspaceCopies)
      .where(
        and(
          eq(projectWorkspaceCopies.id, id),
          eq(projectWorkspaceCopies.projectId, projectId),
        ),
      )
      .get();
    if (!copy) throw new NotFoundException('Working copy not found');
    return copy;
  }

  private view(copy: ProjectWorkspaceCopy): WorkspaceCopyView {
    const workspace = this.db
      .select({ path: projectWorkspaces.path })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, copy.localWorkspaceId))
      .get();
    const sourceLocation = this.db
      .select()
      .from(projectLocations)
      .where(
        and(
          eq(projectLocations.legacyResourceId, copy.sourceResourceId),
          eq(projectLocations.projectId, copy.projectId),
        ),
      )
      .get();
    const source = sourceLocation?.connectionId
      ? this.db
          .select()
          .from(projectConnections)
          .where(
            and(
              eq(projectConnections.id, sourceLocation.connectionId),
              eq(projectConnections.projectId, copy.projectId),
            ),
          )
          .get()
      : null;
    const location = this.db
      .select()
      .from(projectLocations)
      .where(
        and(
          eq(projectLocations.localWorkspaceId, copy.localWorkspaceId),
          eq(projectLocations.projectId, copy.projectId),
        ),
      )
      .get();
    return {
      ...copy,
      state:
        source && source.enabled && location?.path === workspace?.path
          ? copy.state
          : 'revoked',
      localPath:
        location?.path === workspace?.path ? (location?.path ?? null) : null,
      sourceName: source?.name ?? null,
      sourceType: source?.protocol ?? null,
      accessMode:
        location?.accessMode === 'read_only' ||
        !location?.capabilities.write ||
        !sourceLocation?.capabilities.write
          ? 'read_only'
          : (sourceLocation?.accessMode ?? null),
      sourceEnabled: Boolean(source?.enabled && location),
    };
  }

  private insertActivity(
    db: AppDatabase,
    projectId: string,
    action: string,
    entityId: string,
    label: string,
    details: Record<string, unknown>,
  ) {
    const identity = currentAccess()?.identity;
    db.insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        action,
        entityType: 'workspace_copy',
        entityId,
        label,
        details,
        actorPersonId: identity?.personId ?? null,
        actorName: identity?.name ?? 'Système',
        createdAt: Date.now(),
      })
      .run();
  }
}
