import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { requireProjectAccess } from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectConnections,
  projectLocations,
  projectWorkspaceCopies,
  projects,
} from '../database/schema';

/** Read-only normalized inventory. Legacy operations remain the write authority. */
@Injectable()
export class ProjectLocationsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

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
    return {
      modelVersion: 1,
      connections: this.db
        .select()
        .from(projectConnections)
        .where(eq(projectConnections.projectId, projectId))
        .all(),
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
