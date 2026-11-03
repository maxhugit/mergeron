import { AgentTeamBusinessService } from './agent-team-business.service';
/** Durable, explicit native dispatch. An uncertain send is never replayed. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { agentTeams, agentTeamProfiles } from '../database/schema';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { ThreadsService } from '../threads/threads.service';
import { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { AgentTeamsService } from './agent-teams.service';
import { defaultTeamProfiles, teamProfilesSchema } from './agent-team-profiles';

@Injectable()
export class AgentTeamLaunchService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly teams: AgentTeamsService,
    private readonly identities: IdentityService,
    private readonly codex: CodexService,
    private readonly threads: ThreadsService,
    private readonly inventory: ThreadExecutionInventoryService,
    private readonly pending: PendingApprovalsService,
    private readonly business: AgentTeamBusinessService,
  ) {}
  onModuleInit() {
    // Preparing precedes the synchronous beforeSend boundary: no input was sent.
    this.db
      .update(agentTeams)
      .set({ state: 'draft', lastError: 'TEAM_PREPARATION_INTERRUPTED' })
      .where(
        and(
          eq(agentTeams.origin, 'planned'),
          eq(agentTeams.state, 'preparing'),
        ),
      )
      .run();
  }
  private actor(
    identity: PlatformIdentity,
    projectId: string,
    coordinator: string,
  ) {
    const actor = this.teams.authorize(identity, projectId, coordinator);
    this.identities.requireAdministrator(actor);
    if (actor.kind !== 'person' || !actor.personId || actor.impersonation)
      throw new ForbiddenException('TEAM_PERSONAL_ADMINISTRATOR_REQUIRED');
    return actor;
  }
  profiles(identity: PlatformIdentity, projectId: string, coordinator: string) {
    this.teams.authorize(identity, projectId, coordinator);
    return (
      this.db
        .select()
        .from(agentTeamProfiles)
        .where(eq(agentTeamProfiles.projectId, projectId))
        .get()?.profiles ?? defaultTeamProfiles
    );
  }
  saveProfiles(
    identity: PlatformIdentity,
    projectId: string,
    coordinator: string,
    value: unknown,
  ) {
    this.actor(identity, projectId, coordinator);
    const parsed = teamProfilesSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('TEAM_INVALID_PROFILES');
    // Reuse the definition validator without persisting a synthetic team.
    this.teams.store.validateAssignments(parsed.data);
    this.db
      .insert(agentTeamProfiles)
      .values({ projectId, profiles: parsed.data, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: agentTeamProfiles.projectId,
        set: { profiles: parsed.data, updatedAt: Date.now() },
      })
      .run();
    return parsed.data;
  }
  prepare(
    identity: PlatformIdentity,
    projectId: string,
    coordinator: string,
    value: unknown,
  ) {
    this.actor(identity, projectId, coordinator);
    const parsed = z
      .strictObject({
        requestId: z.string(),
        objective: z.string(),
        profiles: teamProfilesSchema.optional(),
      })
      .safeParse(value);
    if (!parsed.success)
      throw new BadRequestException('TEAM_INVALID_DEFINITION');
    return this.teams.store.create(projectId, coordinator, {
      requestId: parsed.data.requestId,
      objective: parsed.data.objective,
      assignments:
        parsed.data.profiles ?? this.profiles(identity, projectId, coordinator),
    });
  }
  private idle(identity: PlatformIdentity, projectId: string, teamId: string) {
    const team = this.teams.read(identity, projectId, teamId);
    this.actor(identity, projectId, team.coordinatorThreadId);
    this.business.assertLaunch(identity, projectId, team);
    if (
      !['preparing', 'dispatching'].includes(team.state) ||
      team.stopRequestedAt
    )
      throw new ConflictException('TEAM_NOT_PREPARING');
    if (
      this.inventory.has(team.coordinatorThreadId) ||
      this.inventory
        .snapshot()
        .some(
          (id) => this.inventory.parentOf(id) === team.coordinatorThreadId,
        ) ||
      this.pending.listPending([team.coordinatorThreadId]).length
    )
      throw new ConflictException('TEAM_COORDINATOR_BUSY');
  }
  private async capability() {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response =
        await this.codex.request<v2.ExperimentalFeatureListResponse>(
          'experimentalFeature/list',
          { cursor, limit: 100 },
        );
      if (
        response.data.some(
          (f) =>
            ['multi_agent', 'multi_agent_v2'].includes(f.name) &&
            f.enabled &&
            f.stage !== 'removed',
        )
      )
        return;
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    throw new ConflictException('TEAM_NATIVE_SUBAGENTS_UNAVAILABLE');
  }
  async launch(identity: PlatformIdentity, projectId: string, teamId: string) {
    const team = this.teams.read(identity, projectId, teamId),
      actor = this.actor(identity, projectId, team.coordinatorThreadId);
    this.business.assertLaunch(identity, projectId, team);
    if (team.state !== 'draft' || team.nativeTurnId)
      throw new ConflictException('TEAM_ALREADY_DISPATCHED');
    // SQLite claim survives another HTTP request or process replacement.
    this.db.transaction(() => {
      if (
        this.db
          .select()
          .from(agentTeams)
          .where(
            and(
              eq(agentTeams.coordinatorThreadId, team.coordinatorThreadId),
              eq(agentTeams.origin, 'planned'),
              inArray(agentTeams.state, [
                'preparing',
                'dispatching',
                'running',
                'stopping',
                'unknown',
                'needs_attention',
              ]),
            ),
          )
          .get()
      )
        throw new ConflictException('TEAM_COORDINATOR_HAS_UNRESOLVED_TEAM');
      const changed = this.db
        .update(agentTeams)
        .set({
          state: 'preparing',
          launchedBy: actor.personId!,
          lastError: null,
        })
        .where(and(eq(agentTeams.id, teamId), eq(agentTeams.state, 'draft')))
        .run();
      if (changed.changes !== 1)
        throw new ConflictException('TEAM_ALREADY_DISPATCHED');
    });
    try {
      await this.capability();
      this.idle(identity, projectId, teamId);
      const instructions = [
        `Team dispatch reference: [mergeron-team:${team.id}]`,
        'Execute the explicitly approved team plan below using your native subagent tools. Do not simulate delegation.',
        'At most two open subagents at once. Do not delegate recursively. Close completed children before opening another.',
        'Children analyze and report without modifying files. This instruction does not change inherited native permissions. You alone write and consolidate; no parallel file edits.',
        'Honor assignment dependencies. Receive the analysis results, prepare the requested synthesis, then ask dependent reviewers to review that synthesis. Do not claim a mission done without its native result.',
        'Put the exact assignment marker at the beginning of each child message, followed by its instructions. Preserve that marker; never substitute another assignment.',
        'Do not create or complete business tasks, validate deliverables, merge or deploy unless separately authorized. Report blocked or failed assignments honestly.',
        `Objective: ${team.objective}`,
        `Linked deliverable ID: ${team.deliverableId ?? 'none'}. Consult business details through the project MCP when needed.`,
        ...team.assignments.map((a) =>
          JSON.stringify({
            marker: `[mergeron-assignment:${a.id}]`,
            role: a.role,
            taskId: a.taskId,
            instructions: a.instructions,
            dependsOn: a.dependencies,
          }),
        ),
      ].join('\n\n');
      const response = await accessContext.run(
        { identity: actor, identities: this.identities },
        () =>
          this.threads.startTurn(
            {
              threadId: team.coordinatorThreadId,
              input: [
                {
                  type: 'text',
                  text:
                    '<mergeron_team_plan>\n' +
                    instructions.replaceAll(
                      '</mergeron_team_plan>',
                      '< /mergeron_team_plan>',
                    ) +
                    '\n</mergeron_team_plan>',
                  text_elements: [],
                },
                {
                  type: 'text',
                  text: `Lancer l’équipe : ${team.objective}`,
                  text_elements: [],
                },
              ],
            },
            {
              assertIdle: () => this.idle(identity, projectId, teamId),
              beforeSend: () => {
                this.idle(identity, projectId, teamId);
                this.teams.store.state(projectId, teamId, 'dispatching');
              },
            },
          ),
      );
      this.teams.store.bindDispatchTurn(
        team.coordinatorThreadId,
        response.turn.id,
      );
      const current = this.teams.read(identity, projectId, teamId);
      if (current.nativeTurnId !== response.turn.id)
        throw new ConflictException('TEAM_DISPATCH_UNCERTAIN');
      if (current.state === 'dispatching')
        this.teams.store.state(projectId, teamId, 'running');
      return this.teams.read(identity, projectId, teamId);
    } catch (error) {
      const current = this.teams.store.read(projectId, teamId);
      if (current.state === 'preparing')
        this.teams.store.state(
          projectId,
          teamId,
          'draft',
          'TEAM_PREPARATION_FAILED',
        );
      else if (!['completed', 'failed', 'stopped'].includes(current.state))
        this.teams.store.state(
          projectId,
          teamId,
          'unknown',
          'TEAM_DISPATCH_UNCERTAIN',
        );
      throw error;
    }
  }
}
