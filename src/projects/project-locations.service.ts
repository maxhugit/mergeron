import {
  ConflictException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { posix } from 'node:path';
import { requireExecutionAccess } from '../auth/access-context';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { requireProjectAccess } from '../auth/access-context';
import { copyAgentIds, copyAgentThreadIds } from './git-copy-ownership';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectConnections,
  projectLocations,
  projectWorkspaceCopies,
  projects,
  projectWorkspaceSecrets,
} from '../database/schema';

/** Read-only normalized inventory. Legacy operations remain the write authority. */
@Injectable()
export class ProjectLocationsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  location(projectId: string, id: string) {
    requireProjectAccess(projectId);
    const location = this.db
      .select()
      .from(projectLocations)
      .where(
        and(
          eq(projectLocations.id, id),
          eq(projectLocations.projectId, projectId),
        ),
      )
      .get();
    if (!location) throw new NotFoundException('Project location not found');
    return location;
  }

  connection(projectId: string, id: string) {
    requireProjectAccess(projectId);
    const connection = this.db
      .select()
      .from(projectConnections)
      .where(
        and(
          eq(projectConnections.id, id),
          eq(projectConnections.projectId, projectId),
        ),
      )
      .get();
    if (!connection)
      throw new NotFoundException('Project connection not found');
    const adapter = this.db
      .select()
      .from(projectLocations)
      .where(eq(projectLocations.legacyResourceId, id))
      .get();
    if (adapter && adapter.connectionId !== id)
      throw new NotFoundException('Project connection not found');
    return connection;
  }

  /** Internal file-access scope, independently of any declared project folder. */
  connectionScope(projectId: string, id: string) {
    this.connection(projectId, id);
    const scope = this.db
      .select()
      .from(projectLocations)
      .where(
        and(
          eq(projectLocations.projectId, projectId),
          eq(projectLocations.legacyResourceId, id),
          eq(projectLocations.connectionId, id),
        ),
      )
      .get();
    if (!scope)
      throw new ConflictException('Project connection scope is unavailable');
    return scope;
  }

  undeclare(projectId: string, id: string) {
    requireExecutionAccess();
    const location = this.location(projectId, id);
    if (location.kind !== 'remote')
      throw new ConflictException('A remote folder is required');
    this.db
      .update(projectLocations)
      .set({ declared: false })
      .where(
        and(
          eq(projectLocations.id, id),
          eq(projectLocations.projectId, projectId),
        ),
      )
      .run();
    return { ok: true, filesDeleted: false };
  }

  /** Reuse access and secrets; a new folder never widens the connection scope. */
  attachRemote(
    projectId: string,
    input: Record<string, unknown>,
    resources: WorkspaceResourcesService,
  ) {
    requireExecutionAccess();
    if (typeof input.connectionId !== 'string')
      throw new BadRequestException('A connection is required');
    const connection = this.connection(projectId, input.connectionId);
    if (!connection.enabled || connection.protocol === 'git')
      throw new ConflictException('An enabled file connection is required');
    const source = resources.get(projectId, connection.id);
    if (
      typeof input.path !== 'string' ||
      !input.path.startsWith('/') ||
      input.path.includes('\0') ||
      input.path.includes('\\') ||
      input.path.split('/').includes('..')
    )
      throw new BadRequestException('An absolute remote directory is required');
    const path = posix.normalize(input.path);
    const root = posix.resolve('/', source.rootPath);
    if (path !== root && !path.startsWith(root === '/' ? '/' : root + '/'))
      throw new BadRequestException(
        'Folder is outside the allowed connection root',
      );
    return this.db.transaction(() => {
      const adapter = resources.create(projectId, {
        name: input.name,
        type: source.type,
        address: source.address,
        rootPath: path,
        accessMode: source.accessMode,
        allowInsecure: source.type === 'ftp',
        agentEnabled: false,
      });
      this.db
        .update(projectLocations)
        .set({ connectionId: connection.id })
        .where(eq(projectLocations.legacyResourceId, adapter.id))
        .run();
      return this.location(projectId, `remote:${adapter.id}`);
    });
  }

  /** Only this boundary translates normalized identifiers to persistence adapters. */
  resourceId(projectId: string, id: string): string {
    const location = this.location(projectId, id);
    const resourceId =
      location.kind === 'remote'
        ? location.legacyResourceId
        : location.localWorkspaceId;
    if (!resourceId)
      throw new ConflictException(
        'Location compatibility reference is unavailable',
      );
    return resourceId;
  }

  workspaceId(projectId: string, id: string): string {
    const location = this.location(projectId, id);
    if (location.kind === 'remote' || !location.localWorkspaceId)
      throw new ConflictException('A local destination location is required');
    return location.localWorkspaceId;
  }

  locationIdForResource(projectId: string, resourceId: string): string {
    requireProjectAccess(projectId);
    const location =
      this.db
        .select()
        .from(projectLocations)
        .where(
          and(
            eq(projectLocations.projectId, projectId),
            eq(projectLocations.legacyResourceId, resourceId),
          ),
        )
        .get() ??
      this.db
        .select()
        .from(projectLocations)
        .where(
          and(
            eq(projectLocations.projectId, projectId),
            eq(projectLocations.localWorkspaceId, resourceId),
          ),
        )
        .get();
    if (!location)
      throw new ConflictException('A referenced project location is detached');
    return location.id;
  }

  list(projectId: string) {
    requireProjectAccess(projectId);
    if (
      !this.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()
    )
      throw new NotFoundException('Project not found');
    const copies = this.db
      .select()
      .from(projectWorkspaceCopies)
      .where(eq(projectWorkspaceCopies.projectId, projectId))
      .all();
    const allConnections = this.db
      .select()
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId))
      .all();
    const locations = this.db
      .select()
      .from(projectLocations)
      .where(eq(projectLocations.projectId, projectId))
      .all();
    const connections = allConnections.filter(
      (c) =>
        !locations.some(
          (l) => l.legacyResourceId === c.id && l.connectionId !== c.id,
        ),
    );
    return {
      modelVersion: 1,
      copies: copies.map((copy) => {
        const location = locations.find(
          (item) => item.localWorkspaceId === copy.localWorkspaceId,
        );
        const source = locations.find(
          (item) => item.legacyResourceId === copy.sourceResourceId,
        );
        const connection = connections.find(
          (item) => item.id === source?.connectionId,
        );
        return {
          ...copy,
          ownerAgentIds: copyAgentIds(this.db, projectId, copy.id),
          ownerThreadIds: copyAgentThreadIds(this.db, projectId, copy.id),
          locationId: location?.id ?? null,
          sourceConnectionId: connection?.id ?? null,
          localPath: location?.path ?? null,
          sourceName: connection?.name ?? null,
          sourceType: connection?.protocol ?? null,
          accessMode:
            location?.accessMode === 'read_only' ||
            !location?.capabilities.write ||
            !source?.capabilities.write
              ? 'read_only'
              : (source?.accessMode ?? null),
          sourceEnabled: Boolean(connection?.enabled),
          state: connection?.enabled ? copy.state : ('revoked' as const),
        };
      }),
      connections: connections.map((connection) => ({
        ...connection,
        fileScope: (() => {
          const scope = locations.find(
            (l) => l.legacyResourceId === connection.id,
          );
          return scope
            ? {
                rootPath: scope.path,
                accessMode: scope.accessMode,
                capabilities: scope.capabilities,
              }
            : null;
        })(),
        hasSecret: Boolean(
          this.db
            .select({ id: projectWorkspaceSecrets.resourceId })
            .from(projectWorkspaceSecrets)
            .where(eq(projectWorkspaceSecrets.resourceId, connection.id))
            .get(),
        ),
      })),
      locations: this.db
        .select()
        .from(projectLocations)
        .where(eq(projectLocations.projectId, projectId))
        .all()
        .filter((location) => location.declared)
        .map((location) => ({
          ...location,
          ...(location.connectionId
            ? (() => {
                const scope = locations.find(
                  (l) => l.legacyResourceId === location.connectionId,
                );
                return scope
                  ? {
                      accessMode:
                        scope.accessMode === 'read_only'
                          ? ('read_only' as const)
                          : location.accessMode,
                      capabilities: {
                        read:
                          location.capabilities.read && scope.capabilities.read,
                        write:
                          location.capabilities.write &&
                          scope.capabilities.write,
                        execute: false as const,
                      },
                    }
                  : {};
              })()
            : {}),
          workingCopyId:
            copies.find(
              (copy) => copy.localWorkspaceId === location.localWorkspaceId,
            )?.id ?? null,
        })),
    };
  }
}
