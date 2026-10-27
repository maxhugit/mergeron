import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
    return connection;
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
    const connections = this.db
      .select()
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId))
      .all();
    const locations = this.db
      .select()
      .from(projectLocations)
      .where(eq(projectLocations.projectId, projectId))
      .all();
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
      connections: this.db
        .select()
        .from(projectConnections)
        .where(eq(projectConnections.projectId, projectId))
        .all()
        .map((connection) => ({
          ...connection,
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
        .map((location) => ({
          ...location,
          workingCopyId:
            copies.find(
              (copy) => copy.localWorkspaceId === location.localWorkspaceId,
            )?.id ?? null,
        })),
    };
  }
}
