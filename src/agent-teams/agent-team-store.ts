/** Persistence only: no timers, model calls, grants, or replay of user input. */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  agentTeams,
  agentTeamAssignments,
  projectAgentThreads,
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

  create(projectId: string, coordinatorThreadId: string, value: unknown) {
    const parsed = definition.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException('TEAM_INVALID_DEFINITION');
    const input = parsed.data;
    const keys = new Set(input.assignments.map((a) => a.key));
    if (keys.size !== input.assignments.length)
      throw new BadRequestException('TEAM_DUPLICATE_MISSION');
    const visited = new Set<string>();
    const visit = (key: string, path = new Set<string>()) => {
      if (path.has(key)) throw new BadRequestException('TEAM_DEPENDENCY_CYCLE');
      if (visited.has(key)) return;
      const assignment = input.assignments.find((a) => a.key === key);
      if (!assignment) throw new BadRequestException('TEAM_UNKNOWN_DEPENDENCY');
      for (const dependency of assignment.dependencies)
        visit(dependency, new Set([...path, key]));
      visited.add(key);
    };
    keys.forEach((key) => visit(key));
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
      .set({ status, result, updatedAt: Date.now() })
      .where(eq(agentTeamAssignments.id, assignment.id))
      .run();
  }
}
