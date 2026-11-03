/** Persistence only: no timers, model calls, grants, or replay of user input. */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  agentTeams,
  agentTeamAssignments,
  projectAgentThreads,
  pendingServerRequests,
} from '../database/schema';

const text = z.string().trim().min(1).max(6000);
const definition = z.strictObject({
  requestId: z.string().regex(/^[\w-]{1,128}$/),
  objective: text,
  assignments: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[\w-]{1,64}$/),
        role: z.string().trim().min(1).max(120),
        instructions: text,
        dependencies: z.array(z.string()).max(12).default([]),
      }),
    )
    .min(1)
    .max(12),
});
export type AssignmentStatus = typeof agentTeamAssignments.$inferSelect.status;

@Injectable()
export class AgentTeamStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  refreshCompletion(projectId: string, id: string) {
    const team = this.read(projectId, id);
    if (['stopping', 'stopped', 'completed', 'failed'].includes(team.state))
      return;
    if (
      team.coordinatorStatus === 'completed' &&
      team.assignments.length &&
      team.assignments.every((a) => a.status === 'completed')
    )
      this.state(projectId, id, 'completed');
    else if (
      team.coordinatorStatus === 'completed' &&
      team.assignments.every((a) =>
        ['planned', 'completed', 'failed', 'cancelled'].includes(a.status),
      )
    )
      this.state(projectId, id, 'needs_attention', 'TEAM_INCOMPLETE_PLAN');
    else if (
      (team.coordinatorStatus === 'failed' ||
        team.coordinatorStatus === 'interrupted') &&
      team.assignments.every((a) =>
        ['completed', 'failed', 'cancelled'].includes(a.status),
      )
    )
      this.state(projectId, id, 'failed');
  }

  attention(projectId: string, id: string, generation: number) {
    const team = this.read(projectId, id),
      ids = [
        team.coordinatorThreadId,
        ...team.assignments.flatMap((a) =>
          a.nativeThreadId ? [a.nativeThreadId] : [],
        ),
      ].slice(0, 65);
    return this.db
      .select({
        threadId: pendingServerRequests.threadId,
        status: pendingServerRequests.status,
        method: pendingServerRequests.method,
      })
      .from(pendingServerRequests)
      .where(
        and(
          inArray(pendingServerRequests.threadId, ids),
          inArray(pendingServerRequests.status, ['pending', 'submitted']),
          eq(pendingServerRequests.generation, generation),
        ),
      )
      .all()
      .map((row) => ({
        threadId: row.threadId,
        status: row.status,
        kind:
          row.method === 'item/tool/requestUserInput'
            ? ('question' as const)
            : ('approval' as const),
      }));
  }

  state(
    projectId: string,
    id: string,
    state: typeof agentTeams.$inferSelect.state,
    lastError: string | null = null,
  ) {
    this.read(projectId, id);
    this.db
      .update(agentTeams)
      .set({ state, lastError })
      .where(eq(agentTeams.id, id))
      .run();
  }
  requestStop(projectId: string, id: string, personId: string) {
    this.read(projectId, id);
    this.db
      .update(agentTeams)
      .set({
        state: 'stopping',
        stopRequestedAt: Date.now(),
        stopPersonId: personId,
        lastError: null,
      })
      .where(eq(agentTeams.id, id))
      .run();
  }
  cancelPlanned(projectId: string, id: string) {
    this.read(projectId, id);
    this.db
      .update(agentTeamAssignments)
      .set({ status: 'cancelled', updatedAt: Date.now() })
      .where(
        and(
          eq(agentTeamAssignments.teamId, id),
          eq(agentTeamAssignments.status, 'planned'),
        ),
      )
      .run();
  }
  bindChildTurn(childId: string, turnId: string) {
    if (!turnId) return;
    const owner = this.child(childId);
    if (!owner) return;
    const assignment = this.read(
      owner.projectId,
      owner.teamId,
    ).assignments.find((a) => a.nativeThreadId === childId)!;
    if (!assignment.nativeTurnId)
      this.db
        .update(agentTeamAssignments)
        .set({ nativeTurnId: turnId })
        .where(eq(agentTeamAssignments.id, assignment.id))
        .run();
  }
  parentObservation(
    threadId: string,
    turnId: string,
    status?: 'inProgress' | 'completed' | 'failed' | 'interrupted',
    summary?: string,
  ) {
    if (!turnId) return;
    this.db
      .update(agentTeams)
      .set({
        ...(status ? { coordinatorStatus: status } : {}),
        ...(summary !== undefined ? { summary: summary.slice(0, 100000) } : {}),
      })
      .where(
        and(
          eq(agentTeams.coordinatorThreadId, threadId),
          eq(agentTeams.nativeTurnId, turnId),
        ),
      )
      .run();
    for (const team of this.db
      .select()
      .from(agentTeams)
      .where(
        and(
          eq(agentTeams.coordinatorThreadId, threadId),
          eq(agentTeams.nativeTurnId, turnId),
        ),
      )
      .all())
      this.refreshCompletion(team.projectId, team.id);
  }

  /** Polling reads never hydrate prompts or potentially large final answers. */
  listSummaries(projectId: string, coordinatorThreadId: string) {
    const teams = this.db
      .select({
        id: agentTeams.id,
        projectId: agentTeams.projectId,
        coordinatorThreadId: agentTeams.coordinatorThreadId,
        nativeTurnId: agentTeams.nativeTurnId,
        origin: agentTeams.origin,
        state: agentTeams.state,
        lastError: agentTeams.lastError,
        objective: agentTeams.objective,
        createdAt: agentTeams.createdAt,
      })
      .from(agentTeams)
      .where(
        and(
          eq(agentTeams.projectId, projectId),
          eq(agentTeams.coordinatorThreadId, coordinatorThreadId),
        ),
      )
      .orderBy(desc(agentTeams.createdAt), desc(agentTeams.id))
      .limit(50)
      .all();
    if (!teams.length) return [];
    const assignments = this.db
      .select({
        id: agentTeamAssignments.id,
        teamId: agentTeamAssignments.teamId,
        role: agentTeamAssignments.role,
        dependencies: agentTeamAssignments.dependencies,
        nativeThreadId: agentTeamAssignments.nativeThreadId,
        status: agentTeamAssignments.status,
        updatedAt: agentTeamAssignments.updatedAt,
      })
      .from(agentTeamAssignments)
      .where(
        inArray(
          agentTeamAssignments.teamId,
          teams.map((t) => t.id),
        ),
      )
      .all();
    return teams.map((team) => ({
      ...team,
      assignments: assignments.filter((a) => a.teamId === team.id),
    }));
  }

  list(projectId: string, coordinatorThreadId: string) {
    return this.db
      .select()
      .from(agentTeams)
      .where(
        and(
          eq(agentTeams.projectId, projectId),
          eq(agentTeams.coordinatorThreadId, coordinatorThreadId),
        ),
      )
      .orderBy(desc(agentTeams.createdAt), desc(agentTeams.id))
      .limit(50)
      .all()
      .map((team) => this.read(projectId, team.id));
  }

  child(childId: string) {
    return this.db
      .select({
        projectId: agentTeams.projectId,
        teamId: agentTeams.id,
        coordinatorThreadId: agentTeams.coordinatorThreadId,
      })
      .from(agentTeamAssignments)
      .innerJoin(agentTeams, eq(agentTeams.id, agentTeamAssignments.teamId))
      .where(eq(agentTeamAssignments.nativeThreadId, childId))
      .get();
  }

  /** Admission evidence comes exclusively from a completed native spawn tool. */
  discoverSpawn(
    parentId: string,
    turnId: string,
    childId: string,
    prompt: string,
  ) {
    if (!parentId || !turnId || !childId || parentId === childId) return;
    return this.db.transaction(() => {
      const parent = this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, parentId))
        .get();
      if (!parent) return; // Nested delegation and unowned sessions are not silently adopted.
      const registeredChild = this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, childId))
        .get();
      if (registeredChild && registeredChild.projectId !== parent.projectId)
        throw new ConflictException('TEAM_CHILD_PROJECT_MISMATCH');
      const existingChild = this.child(childId);
      if (existingChild) {
        if (
          existingChild.coordinatorThreadId !== parentId ||
          existingChild.projectId !== parent.projectId
        )
          throw new ConflictException('TEAM_CHILD_ALREADY_OWNED');
        return existingChild;
      }
      let team = this.db
        .select()
        .from(agentTeams)
        .where(
          and(
            eq(agentTeams.projectId, parent.projectId),
            eq(agentTeams.coordinatorThreadId, parentId),
            eq(agentTeams.nativeTurnId, turnId),
          ),
        )
        .get();
      const now = Date.now();
      if (!team) {
        const id = randomUUID();
        const requestId =
          'native-' + createHash('sha256').update(turnId).digest('hex');
        this.db
          .insert(agentTeams)
          .values({
            id,
            projectId: parent.projectId,
            coordinatorThreadId: parentId,
            nativeTurnId: turnId,
            origin: 'observed',
            requestId,
            fingerprint: requestId,
            objective: 'Travail délégué par le coordinateur',
            createdAt: now,
          })
          .run();
        team = this.db
          .select()
          .from(agentTeams)
          .where(eq(agentTeams.id, id))
          .get()!;
      }
      // A prompt marker selects a definition; it is never an access grant.
      const assignmentId = /\[mergeron-assignment:([a-f0-9-]{36})\]/i.exec(
        prompt,
      )?.[1];
      const planned =
        assignmentId &&
        this.read(parent.projectId, team.id).assignments.find(
          (a) =>
            a.id === assignmentId &&
            a.status === 'planned' &&
            !a.nativeThreadId,
        );
      if (planned)
        this.bind(parent.projectId, team.id, planned.id, childId, parentId);
      else
        this.db
          .insert(agentTeamAssignments)
          .values({
            id: randomUUID(),
            teamId: team.id,
            role: 'Sous-agent',
            instructions:
              prompt.slice(0, 6000) || 'Mission déléguée par le coordinateur',
            dependencies: [],
            nativeThreadId: childId,
            status: 'unknown',
            updatedAt: now,
          })
          .run();
      return this.child(childId);
    });
  }

  /** A disconnected transport does not prove any execution ended. */
  markUncertain() {
    this.db
      .update(agentTeamAssignments)
      .set({ status: 'unknown', updatedAt: Date.now() })
      .where(inArray(agentTeamAssignments.status, ['running']))
      .run();
    this.db
      .update(agentTeams)
      .set({ state: 'unknown', lastError: 'TEAM_ENGINE_RESTART' })
      .where(inArray(agentTeams.state, ['dispatching', 'running', 'stopping']))
      .run();
  }

  saveResult(childId: string, result: string) {
    this.db
      .update(agentTeamAssignments)
      .set({ result: result.slice(0, 100000), updatedAt: Date.now() })
      .where(
        and(
          eq(agentTeamAssignments.nativeThreadId, childId),
          inArray(agentTeamAssignments.status, ['unknown', 'running']),
        ),
      )
      .run();
  }

  bindDispatchTurn(threadId: string, turnId: string) {
    if (!turnId) return;
    this.db
      .update(agentTeams)
      .set({ nativeTurnId: turnId, coordinatorStatus: 'inProgress' })
      .where(
        and(
          eq(agentTeams.coordinatorThreadId, threadId),
          eq(agentTeams.origin, 'planned'),
          eq(agentTeams.state, 'dispatching'),
          sql`${agentTeams.nativeTurnId} IS NULL`,
        ),
      )
      .run();
  }
  validateAssignments(
    assignments: Array<{ key: string; dependencies: string[] }>,
  ) {
    const keys = new Set(assignments.map((a) => a.key));
    if (keys.size !== assignments.length)
      throw new BadRequestException('TEAM_DUPLICATE_MISSION');
    const visited = new Set<string>();
    const visit = (key: string, path = new Set<string>()) => {
      if (path.has(key)) throw new BadRequestException('TEAM_DEPENDENCY_CYCLE');
      if (visited.has(key)) return;
      const assignment = assignments.find((a) => a.key === key);
      if (!assignment) throw new BadRequestException('TEAM_UNKNOWN_DEPENDENCY');
      for (const dependency of assignment.dependencies)
        visit(dependency, new Set([...path, key]));
      visited.add(key);
    };
    keys.forEach((key) => visit(key));
  }

  create(projectId: string, coordinatorThreadId: string, value: unknown) {
    const parsed = definition.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException('TEAM_INVALID_DEFINITION');
    const input = parsed.data;
    this.validateAssignments(input.assignments);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    return this.db.transaction(() => {
      if (
        !this.db
          .select()
          .from(projectAgentThreads)
          .where(
            and(
              eq(projectAgentThreads.threadId, coordinatorThreadId),
              eq(projectAgentThreads.projectId, projectId),
            ),
          )
          .get()
      )
        throw new NotFoundException('TEAM_COORDINATOR_NOT_FOUND');
      const existing = this.db
        .select()
        .from(agentTeams)
        .where(
          and(
            eq(agentTeams.projectId, projectId),
            eq(agentTeams.coordinatorThreadId, coordinatorThreadId),
            eq(agentTeams.requestId, input.requestId),
          ),
        )
        .get();
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ConflictException('TEAM_REQUEST_REUSED');
        return this.read(projectId, existing.id);
      }
      const id = randomUUID();
      const now = Date.now();
      this.db
        .insert(agentTeams)
        .values({
          id,
          projectId,
          coordinatorThreadId,
          requestId: input.requestId,
          objective: input.objective,
          fingerprint,
          state: 'draft',
          createdAt: now,
        })
        .run();
      const ids = new Map(input.assignments.map((a) => [a.key, randomUUID()]));
      for (const a of input.assignments)
        this.db
          .insert(agentTeamAssignments)
          .values({
            id: ids.get(a.key)!,
            teamId: id,
            role: a.role,
            instructions: a.instructions,
            dependencies: a.dependencies.map((key) => ids.get(key)!),
            status: 'planned',
            updatedAt: now,
          })
          .run();
      return this.read(projectId, id);
    });
  }

  read(projectId: string, id: string) {
    const team = this.db
      .select()
      .from(agentTeams)
      .where(and(eq(agentTeams.id, id), eq(agentTeams.projectId, projectId)))
      .get();
    if (!team) throw new NotFoundException('TEAM_NOT_FOUND');
    return {
      ...team,
      assignments: this.db
        .select()
        .from(agentTeamAssignments)
        .where(eq(agentTeamAssignments.teamId, id))
        .all(),
    };
  }

  /** Only a trusted native-parent observation may bind a child, never a fork. */
  bind(
    projectId: string,
    teamId: string,
    assignmentId: string,
    childId: string,
    observedParentId: string,
  ) {
    const team = this.read(projectId, teamId);
    if (
      childId === team.coordinatorThreadId ||
      observedParentId !== team.coordinatorThreadId
    )
      throw new ConflictException('TEAM_INVALID_PARENT');
    const registeredChild = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, childId))
      .get();
    if (registeredChild && registeredChild.projectId !== projectId)
      throw new ConflictException('TEAM_CHILD_PROJECT_MISMATCH');
    const assignment = team.assignments.find((a) => a.id === assignmentId);
    if (!assignment) throw new NotFoundException('TEAM_ASSIGNMENT_NOT_FOUND');
    if (assignment.nativeThreadId === childId) return;
    if (assignment.nativeThreadId || assignment.status !== 'planned')
      throw new ConflictException('TEAM_ALREADY_BOUND');
    this.db
      .update(agentTeamAssignments)
      .set({
        nativeThreadId: childId,
        status: 'unknown',
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(agentTeamAssignments.id, assignmentId),
          eq(agentTeamAssignments.status, 'planned'),
        ),
      )
      .run();
  }

  /** Reconnection/idle is not evidence of success. Terminal observations are sticky. */
  observe(
    projectId: string,
    teamId: string,
    childId: string,
    status: AssignmentStatus,
    result: string | null = null,
  ) {
    const team = this.read(projectId, teamId);
    const assignment = team.assignments.find(
      (a) => a.nativeThreadId === childId,
    );
    if (!assignment) throw new NotFoundException('TEAM_CHILD_NOT_FOUND');
    if (['completed', 'failed', 'cancelled'].includes(assignment.status))
      return;
    if (status === 'planned' || (result !== null && result.length > 100000))
      throw new BadRequestException('TEAM_INVALID_OBSERVATION');
    this.db
      .update(agentTeamAssignments)
      .set({
        status,
        ...(result === null ? {} : { result }),
        updatedAt: Date.now(),
      })
      .where(eq(agentTeamAssignments.id, assignment.id))
      .run();
    this.refreshCompletion(projectId, teamId);
  }
}
