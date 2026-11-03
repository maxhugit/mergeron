/** Explicit business links and confirmed task proposals; never automatic validation. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  agentTeams,
  agentTeamAssignments,
  projectDeliverables,
  projectResources,
  projectTasks,
  projectActivity,
} from '../database/schema';
import { randomUUID } from 'node:crypto';
import { accessContext } from '../auth/access-context';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { ProjectsService } from '../projects/projects.service';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamVisibilityService } from './agent-team-visibility.service';
const id = z.string().regex(/^[\w-]{1,128}$/);
@Injectable()
export class AgentTeamBusinessService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly teams: AgentTeamsService,
    private readonly identities: IdentityService,
    private readonly visibility: AgentTeamVisibilityService,
    private readonly projects: ProjectsService,
  ) {}
  assertLaunch(
    identity: PlatformIdentity,
    projectId: string,
    team: {
      deliverableId: string | null;
      assignments: Array<{ taskId: string | null }>;
    },
  ) {
    if (
      team.deliverableId &&
      this.visibility.deliverable(identity, projectId, team.deliverableId)
        .confidentiality !== 'standard'
    )
      throw new ConflictException(
        'TEAM_RESTRICTED_DELIVERABLE_REQUIRES_PRIVATE_CONVERSATION',
      );
    for (const assignment of team.assignments)
      if (assignment.taskId) this.visibility.task(projectId, assignment.taskId);
  }
  private administrator(
    identity: PlatformIdentity,
    projectId: string,
    teamId: string,
  ) {
    const team = this.teams.read(identity, projectId, teamId),
      actor = this.teams.authorize(
        identity,
        projectId,
        team.coordinatorThreadId,
      );
    this.identities.requireAdministrator(actor);
    if (actor.kind !== 'person' || !actor.personId || actor.impersonation)
      throw new ForbiddenException('TEAM_PERSONAL_ADMINISTRATOR_REQUIRED');
    return { team, actor };
  }
  private board(projectId: string, resourceId: string) {
    const board = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.id, resourceId),
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, 'task_board'),
        ),
      )
      .get();
    if (!board || board.config.internal === true)
      throw new NotFoundException('TEAM_TASK_BOARD_NOT_FOUND');
    return board;
  }
  context(identity: PlatformIdentity, projectId: string, coordinator: string) {
    const actor = this.teams.authorize(identity, projectId, coordinator);
    const boards = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, 'task_board'),
        ),
      )
      .all()
      .filter((r) => r.config.internal !== true)
      .map((r) => ({ id: r.id, name: r.name }));
    const candidates = this.db
      .select({ item: projectDeliverables, resource: projectResources })
      .from(projectDeliverables)
      .innerJoin(
        projectResources,
        eq(projectResources.id, projectDeliverables.resourceId),
      )
      .where(
        and(
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, 'deliverable_board'),
        ),
      )
      .limit(301)
      .all();
    const deliverables = candidates
      .filter(
        ({ item, resource }) =>
          item.confidentiality === 'standard' &&
          resource.config.internal !== true,
      )
      .slice(0, 300)
      .flatMap(({ item }) => {
        try {
          this.visibility.deliverable(actor, projectId, item.id);
          return [{ id: item.id, title: item.title }];
        } catch {
          return [];
        }
      });
    const tasks = boards.length
      ? this.db
          .select({
            id: projectTasks.id,
            title: projectTasks.title,
            resourceId: projectTasks.resourceId,
          })
          .from(projectTasks)
          .where(
            inArray(
              projectTasks.resourceId,
              boards.map((b) => b.id),
            ),
          )
          .limit(501)
          .all()
      : [];
    return {
      boards,
      deliverables,
      tasks: tasks.slice(0, 500),
      truncated: candidates.length > 300 || tasks.length > 500,
    };
  }
  links(
    identity: PlatformIdentity,
    projectId: string,
    teamId: string,
    value: unknown,
  ) {
    const { team, actor } = this.administrator(identity, projectId, teamId);
    if (team.origin !== 'planned' || team.state !== 'draft')
      throw new ConflictException('TEAM_LINKS_LOCKED_AFTER_LAUNCH');
    const parsed = z
      .strictObject({
        deliverableId: id.nullable(),
        assignments: z
          .array(z.strictObject({ id, taskId: id.nullable() }))
          .max(12),
      })
      .safeParse(value);
    if (!parsed.success) throw new BadRequestException('TEAM_INVALID_LINKS');
    const input = parsed.data;
    if (
      new Set(input.assignments.map((a) => a.id)).size !==
      input.assignments.length
    )
      throw new BadRequestException('TEAM_DUPLICATE_ASSIGNMENT');
    if (
      input.deliverableId &&
      this.visibility.deliverable(actor, projectId, input.deliverableId)
        .confidentiality !== 'standard'
    )
      throw new ConflictException(
        'TEAM_RESTRICTED_DELIVERABLE_REQUIRES_PRIVATE_CONVERSATION',
      );
    for (const assignment of input.assignments) {
      if (!team.assignments.some((a) => a.id === assignment.id))
        throw new NotFoundException('TEAM_ASSIGNMENT_NOT_FOUND');
      if (assignment.taskId) this.visibility.task(projectId, assignment.taskId);
    }
    this.db.transaction(() => {
      this.db
        .update(agentTeams)
        .set({ deliverableId: input.deliverableId })
        .where(eq(agentTeams.id, teamId))
        .run();
      for (const assignment of input.assignments)
        this.db
          .update(agentTeamAssignments)
          .set({ taskId: assignment.taskId, updatedAt: Date.now() })
          .where(
            and(
              eq(agentTeamAssignments.id, assignment.id),
              eq(agentTeamAssignments.teamId, teamId),
            ),
          )
          .run();
      this.audit(
        projectId,
        teamId,
        actor.personId!,
        actor.name ?? 'Administrateur',
        'agent_team_links_updated',
      );
    });
    return this.teams.read(identity, projectId, teamId);
  }
  createTask(
    identity: PlatformIdentity,
    projectId: string,
    teamId: string,
    assignmentId: string,
    value: unknown,
  ) {
    const { team, actor } = this.administrator(identity, projectId, teamId);
    const parsed = z
      .strictObject({
        confirmed: z.literal(true),
        resourceId: id,
        title: z.string().trim().min(1).max(200),
        description: z.string().max(10000),
      })
      .safeParse(value);
    if (!parsed.success)
      throw new BadRequestException('TEAM_TASK_CONFIRMATION_REQUIRED');
    const assignment = team.assignments.find((a) => a.id === assignmentId);
    if (!assignment) throw new NotFoundException('TEAM_ASSIGNMENT_NOT_FOUND');
    if (
      !['completed', 'failed', 'cancelled'].includes(assignment.status) ||
      !assignment.result
    )
      throw new ConflictException('TEAM_CONTRIBUTION_NOT_READY');
    if (
      team.deliverableId &&
      this.visibility.deliverable(actor, projectId, team.deliverableId)
        .confidentiality !== 'standard'
    )
      throw new ConflictException('TEAM_RESTRICTED_CONTRIBUTION');
    this.board(projectId, parsed.data.resourceId);
    return accessContext.run(
      { identity: actor, identities: this.identities },
      () =>
        this.db.transaction(() => {
          const current = this.teams
            .read(identity, projectId, teamId)
            .assignments.find((a) => a.id === assignmentId)!;
          if (current.taskId)
            return this.visibility.task(projectId, current.taskId);
          const task = this.projects.createTask(
            projectId,
            parsed.data.resourceId,
            {
              title: parsed.data.title,
              description: parsed.data.description,
              executionMode: 'manual',
            },
            { personId: actor.personId!, name: actor.name ?? 'Administrateur' },
          );
          this.db
            .update(agentTeamAssignments)
            .set({ taskId: task.id, updatedAt: Date.now() })
            .where(eq(agentTeamAssignments.id, assignmentId))
            .run();
          this.audit(
            projectId,
            teamId,
            actor.personId!,
            actor.name ?? 'Administrateur',
            'agent_team_task_created',
          );
          return task;
        }),
    );
  }
  contributions(
    identity: PlatformIdentity,
    projectId: string,
    taskId?: string,
    deliverableId?: string,
  ) {
    const actor = this.identities.current(identity);
    this.identities.requireProject(actor, projectId);
    if (
      !!taskId === !!deliverableId ||
      (taskId && !id.safeParse(taskId).success) ||
      (deliverableId && !id.safeParse(deliverableId).success)
    )
      throw new BadRequestException('TEAM_ONE_TARGET_REQUIRED');
    if (taskId) this.visibility.task(projectId, taskId);
    if (deliverableId)
      this.visibility.deliverable(actor, projectId, deliverableId);
    const rows = this.db
      .select({ team: agentTeams })
      .from(agentTeams)
      .innerJoin(
        agentTeamAssignments,
        eq(agentTeamAssignments.teamId, agentTeams.id),
      )
      .where(
        and(
          eq(agentTeams.projectId, projectId),
          taskId
            ? eq(agentTeamAssignments.taskId, taskId)
            : eq(agentTeams.deliverableId, deliverableId!),
        ),
      )
      .orderBy(desc(agentTeams.createdAt))
      .limit(200)
      .all();
    return {
      teams: [...new Set(rows.map(({ team }) => team.id))]
        .slice(0, 20)
        .flatMap((id) => {
          try {
            const team = this.teams.read(identity, projectId, id);
            return [
              {
                id: team.id,
                coordinatorThreadId: team.coordinatorThreadId,
                objective: team.objective,
                state: team.state,
                assignments: team.assignments
                  .filter((a) => !taskId || a.taskId === taskId)
                  .map((a) => ({
                    id: a.id,
                    role: a.role,
                    status: a.status,
                    result: a.result?.slice(0, 4000) ?? null,
                  })),
              },
            ];
          } catch {
            return [];
          }
        }),
    };
  }
  private audit(
    projectId: string,
    teamId: string,
    personId: string,
    name: string,
    action: string,
  ) {
    this.db
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        entityType: 'agent_team',
        entityId: teamId,
        action,
        label: 'Équipe',
        actorPersonId: personId,
        actorName: name,
        createdAt: Date.now(),
      })
      .run();
  }
}
