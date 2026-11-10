/** Team references never substitute for the business object's access checks. */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectDeliverables,
  projectResources,
  projectTasks,
} from '../database/schema';
import { accessContext } from '../auth/access-context';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
@Injectable()
export class AgentTeamVisibilityService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly identities: IdentityService,
    private readonly deliverables: DeliverablesService,
  ) {}
  deliverable(identity: PlatformIdentity, projectId: string, id: string) {
    const actor = this.identities.current(identity);
    this.identities.requireProject(actor, projectId);
    const row = this.db
      .select({ item: projectDeliverables, resource: projectResources })
      .from(projectDeliverables)
      .innerJoin(
        projectResources,
        eq(projectResources.id, projectDeliverables.resourceId),
      )
      .where(
        and(
          eq(projectDeliverables.id, id),
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, 'deliverable_board'),
        ),
      )
      .get();
    if (!row || row.resource.config.internal === true)
      throw new NotFoundException('TEAM_TARGET_NOT_FOUND');
    return accessContext.run(
      { identity: actor, identities: this.identities },
      () => this.deliverables.get(projectId, row.resource.id, id),
    );
  }
  task(projectId: string, id: string) {
    const row = this.db
      .select({ task: projectTasks, resource: projectResources })
      .from(projectTasks)
      .innerJoin(
        projectResources,
        eq(projectResources.id, projectTasks.resourceId),
      )
      .where(
        and(
          eq(projectTasks.id, id),
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, 'task_board'),
        ),
      )
      .get();
    if (!row || row.resource.config.internal === true)
      throw new NotFoundException('TEAM_TARGET_NOT_FOUND');
    return row.task;
  }
  assert(
    identity: PlatformIdentity,
    projectId: string,
    team: {
      deliverableId?: string | null;
      assignments: Array<{ taskId?: string | null }>;
    },
  ) {
    const actor = this.identities.current(identity);
    this.identities.requireProject(actor, projectId);
    // Administrators can inspect retained orphan references and safely stop work.
    if (actor.role === 'administrator') return;
    if (team.deliverableId)
      this.deliverable(actor, projectId, team.deliverableId);
    for (const assignment of team.assignments)
      if (assignment.taskId) this.task(projectId, assignment.taskId);
  }
  canRead(
    identity: PlatformIdentity,
    projectId: string,
    team: Parameters<AgentTeamVisibilityService['assert']>[2],
  ) {
    try {
      this.assert(identity, projectId, team);
      return true;
    } catch {
      return false;
    }
  }
}
