/** Explicit, bounded controls. Observation never starts or resumes native work. */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { accessContext } from '../auth/access-context';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { ThreadHistoryService } from '../threads/thread-history.service';
import { ThreadsService } from '../threads/threads.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { AgentTeamsService } from './agent-teams.service';
import type { AssignmentStatus } from './agent-team-store';

const terminal = (status: string) =>
  ['completed', 'failed', 'cancelled'].includes(status);
const nativeStatus = (status: string): AssignmentStatus | undefined =>
  (
    ({
      inProgress: 'running',
      completed: 'completed',
      failed: 'failed',
      interrupted: 'cancelled',
    }) as Record<string, AssignmentStatus>
  )[status];

@Injectable()
export class AgentTeamControlsService {
  private readonly stopping = new Set<string>();
  constructor(
    private readonly teams: AgentTeamsService,
    private readonly identities: IdentityService,
    private readonly history: ThreadHistoryService,
    private readonly threads: ThreadsService,
    private readonly manager: CodexProcessManager,
    private readonly pending: PendingApprovalsService,
  ) {}

  private actor(identity: PlatformIdentity, projectId: string, teamId: string) {
    const team = this.teams.read(identity, projectId, teamId);
    const actor = this.teams.authorize(
      identity,
      projectId,
      team.coordinatorThreadId,
    );
    this.identities.requireAdministrator(actor);
    if (actor.kind !== 'person' || !actor.personId || actor.impersonation)
      throw new ForbiddenException('TEAM_PERSONAL_ADMINISTRATOR_REQUIRED');
    if (team.assignments.length > 64)
      throw new ConflictException('TEAM_CONTROL_MEMBER_LIMIT');
    return { team, actor };
  }
  private generation(generation: number) {
    if (this.manager.getGeneration() !== generation)
      throw new ConflictException('TEAM_ENGINE_CHANGED');
  }
  private async nativeChild(parentId: string, childId: string) {
    const response = await this.history.readThreadMetadata(childId);
    if (
      response.thread.id !== childId ||
      response.thread.parentThreadId !== parentId
    )
      throw new ConflictException('TEAM_NATIVE_PARENT_MISMATCH');
    return response.thread;
  }
  details(identity: PlatformIdentity, projectId: string, teamId: string) {
    const team = this.teams.read(identity, projectId, teamId),
      actor = this.teams.authorize(
        identity,
        projectId,
        team.coordinatorThreadId,
      );
    const canRespond =
      actor.role === 'administrator' &&
      actor.kind === 'person' &&
      !actor.impersonation &&
      team.assignments.length <= 64;
    const ids = [
      team.coordinatorThreadId,
      ...team.assignments.flatMap((a) =>
        a.nativeThreadId ? [a.nativeThreadId] : [],
      ),
    ];
    // The common request path retains immutable instance IDs, generation and grants.
    const requests = canRespond
      ? accessContext.run(
          { identity: actor, identities: this.identities },
          () => this.pending.readPending(ids).requests,
        )
      : [];
    return {
      ...team,
      canRespond,
      requests,
      attention: this.teams.store.attention(
        projectId,
        teamId,
        this.manager.getGeneration(),
      ),
      controlsLimited: team.assignments.length > 64,
    };
  }

  async messages(
    identity: PlatformIdentity,
    projectId: string,
    teamId: string,
    assignmentId: string,
    cursor?: string,
  ) {
    const team = this.teams.read(identity, projectId, teamId),
      assignment = team.assignments.find((a) => a.id === assignmentId);
    if (!assignment?.nativeThreadId)
      throw new NotFoundException('TEAM_CHILD_NOT_FOUND');
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' || cursor.length > 4096)
    )
      throw new ConflictException('TEAM_INVALID_CURSOR');
    const generation = this.manager.getGeneration();
    await this.nativeChild(team.coordinatorThreadId, assignment.nativeThreadId);
    const page = await this.history.listTurns({
      threadId: assignment.nativeThreadId,
      cursor,
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'full',
    });
    this.generation(generation);
    this.teams.read(identity, projectId, teamId);
    const messages = page.data.flatMap((turn) =>
      turn.items.flatMap<{ id: string; role: 'agent' | 'user'; text: string }>(
        (item) => {
          if (item.type === 'agentMessage')
            return [
              {
                id: item.id,
                role: 'agent' as const,
                text: item.text.slice(0, 40000),
              },
            ];
          if (item.type === 'userMessage')
            return [
              {
                id: item.id,
                role: 'user' as const,
                text: item.content
                  .flatMap((c) => (c.type === 'text' ? [c.text] : []))
                  .join('\n')
                  .slice(0, 40000),
              },
            ];
          return [];
        },
      ),
    );
    return { messages, nextCursor: page.nextCursor };
  }

  async reconcile(
    identity: PlatformIdentity,
    projectId: string,
    teamId: string,
  ) {
    const { team } = this.actor(identity, projectId, teamId),
      generation = this.manager.getGeneration();
    for (const assignment of team.assignments) {
      if (!assignment.nativeThreadId || terminal(assignment.status)) continue;
      await this.nativeChild(
        team.coordinatorThreadId,
        assignment.nativeThreadId,
      );
      const page = await this.history.listTurns({
        threadId: assignment.nativeThreadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      this.generation(generation);
      this.actor(identity, projectId, teamId);
      const turn = page.data[0];
      if (!turn) continue; // Idle or an empty page never proves completion.
      if (assignment.nativeTurnId && assignment.nativeTurnId !== turn.id)
        continue;
      this.teams.store.bindChildTurn(assignment.nativeThreadId, turn.id);
      const status = nativeStatus(turn.status);
      const answer = turn.items
        .filter(
          (item) =>
            item.type === 'agentMessage' &&
            (item.phase === 'final_answer' || item.phase === null),
        )
        .at(-1);
      if (answer?.type === 'agentMessage')
        this.teams.store.saveResult(assignment.nativeThreadId, answer.text);
      if (status)
        this.teams.store.observe(
          projectId,
          teamId,
          assignment.nativeThreadId,
          status,
        );
    }
    const parent = await this.history.listTurns({
      threadId: team.coordinatorThreadId,
      limit: 20,
      sortDirection: 'desc',
      itemsView: 'summary',
    });
    this.generation(generation);
    this.actor(identity, projectId, teamId);
    const turn = parent.data.find((t) => t.id === team.nativeTurnId);
    if (turn?.status === 'inProgress' && !team.stopRequestedAt)
      this.teams.store.state(projectId, teamId, 'running');
    if (turn && turn.status !== 'inProgress')
      this.teams.store.parentObservation(
        team.coordinatorThreadId,
        turn.id,
        turn.status,
      );
    const current = this.teams.store.read(projectId, teamId);
    if (
      current.stopRequestedAt &&
      current.assignments.every((a) => terminal(a.status)) &&
      turn &&
      turn.status !== 'inProgress'
    )
      this.teams.store.state(projectId, teamId, 'stopped');
    return this.details(identity, projectId, teamId);
  }

  async stop(identity: PlatformIdentity, projectId: string, teamId: string) {
    const { team, actor } = this.actor(identity, projectId, teamId);
    if (['draft', 'preparing'].includes(team.state) && !team.nativeTurnId) {
      this.teams.store.requestStop(projectId, teamId, actor.personId!);
      this.teams.store.cancelPlanned(projectId, teamId);
      this.teams.store.state(projectId, teamId, 'stopped');
      return this.details(identity, projectId, teamId);
    }
    if (['completed', 'stopped'].includes(team.state))
      return this.details(identity, projectId, teamId);
    if (this.stopping.has(teamId))
      throw new ConflictException('TEAM_STOP_IN_PROGRESS');
    this.stopping.add(teamId);
    this.teams.store.requestStop(projectId, teamId, actor.personId!);
    const generation = this.manager.getGeneration();
    try {
      await accessContext.run(
        { identity: actor, identities: this.identities },
        async () => {
          const parent = await this.history.listTurns({
            threadId: team.coordinatorThreadId,
            limit: 20,
            sortDirection: 'desc',
            itemsView: 'summary',
          });
          this.generation(generation);
          this.actor(identity, projectId, teamId);
          const active = parent.data.find(
            (t) => t.id === team.nativeTurnId && t.status === 'inProgress',
          );
          if (active)
            await this.threads.interruptTurn(
              team.coordinatorThreadId,
              active.id,
            );
          for (const assignment of this.teams.store.read(projectId, teamId)
            .assignments) {
            if (!assignment.nativeThreadId || terminal(assignment.status))
              continue;
            await this.nativeChild(
              team.coordinatorThreadId,
              assignment.nativeThreadId,
            );
            const turns = await this.history.listTurns({
              threadId: assignment.nativeThreadId,
              limit: 1,
              sortDirection: 'desc',
              itemsView: 'summary',
            });
            this.generation(generation);
            this.actor(identity, projectId, teamId);
            const turn = turns.data[0];
            if (
              turn?.status === 'inProgress' &&
              (!assignment.nativeTurnId || assignment.nativeTurnId === turn.id)
            )
              await this.threads.interruptTurn(
                assignment.nativeThreadId,
                turn.id,
              );
          }
          this.generation(generation);
          this.actor(identity, projectId, teamId);
          this.teams.store.cancelPlanned(projectId, teamId);
          await this.reconcile(identity, projectId, teamId);
          if (this.teams.store.read(projectId, teamId).state !== 'stopped')
            this.teams.store.state(
              projectId,
              teamId,
              'unknown',
              'TEAM_STOP_UNCONFIRMED',
            );
        },
      );
    } catch {
      this.teams.store.state(
        projectId,
        teamId,
        'unknown',
        'TEAM_STOP_UNCONFIRMED',
      );
      // The intent is retained, but no command or human decision is replayed.
    } finally {
      this.stopping.delete(teamId);
    }
    return this.details(identity, projectId, teamId);
  }
}
