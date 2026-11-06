import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  canReadThread,
  requireProjectAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  agentMonitors,
  projectAgentThreads,
  projectPullRequests,
  projectPullRequestAgents,
} from '../database/schema';
import { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';

export type PrPhase = 'idle' | 'working' | 'watching' | 'attention';
export const PR_CLAIM_TTL = 15 * 60_000;

@Injectable()
export class PullRequestTrackerService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly executions: ThreadExecutionInventoryService,
    private readonly metadata: ThreadMetadataService,
  ) {}

  private member(projectId: string, threadId: string) {
    requireProjectAccess(projectId);
    requireThreadAccess(threadId);
    const binding = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    if (binding?.projectId !== projectId || binding.archivedAt !== null)
      throw new ForbiddenException('PR_AGENT_UNAVAILABLE');
  }

  async candidates(projectId: string) {
    requireProjectAccess(projectId);
    // Membership outlives CLI history. A missing runtime conversation must not
    // be offered as an opaque ID or confused with an available agent.
    const { entries } = await this.metadata.read();
    const available = new Map(
      entries
        .filter((entry) => !entry.archived)
        .map((entry) => [entry.thread.id, entry.thread]),
    );
    return this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.projectId, projectId))
      .all()
      .filter(
        (row) =>
          row.archivedAt === null &&
          available.has(row.threadId) &&
          canReadThread(row.threadId),
      )
      .map((row) => ({
        threadId: row.threadId,
        name:
          available.get(row.threadId)?.name ||
          available.get(row.threadId)?.preview?.slice(0, 80) ||
          row.threadId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Manual association never invents a creator or starts an execution. */
  assign(
    projectId: string,
    repository: string,
    number: number,
    threadId: string,
  ) {
    this.member(projectId, threadId);
    return this.db.transaction(() => {
      const key = { projectId, repository: repository.toLowerCase(), number };
      const linked = this.db
        .select()
        .from(projectPullRequestAgents)
        .where(
          and(
            eq(projectPullRequestAgents.projectId, key.projectId),
            eq(projectPullRequestAgents.repository, key.repository),
            eq(projectPullRequestAgents.number, key.number),
          ),
        )
        .all();
      const creator = this.db
        .select()
        .from(projectPullRequests)
        .where(
          and(
            eq(projectPullRequests.projectId, key.projectId),
            eq(projectPullRequests.repository, key.repository),
            eq(projectPullRequests.number, key.number),
          ),
        )
        .get();
      if (creator || linked.length)
        throw new ConflictException('PR_ALREADY_ASSIGNED');
      this.claim(projectId, repository, number, threadId, 'idle');
      return this.snapshot(projectId, repository, number);
    });
  }

  created(
    projectId: string,
    repository: string,
    number: number,
    threadId: string,
  ) {
    this.member(projectId, threadId);
    this.db
      .insert(projectPullRequests)
      .values({
        projectId,
        repository: repository.toLowerCase(),
        number,
        creatorThreadId: threadId,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    this.claim(projectId, repository, number, threadId, 'idle');
  }

  claim(
    projectId: string,
    repository: string,
    number: number,
    threadId: string,
    phase: PrPhase,
    turnId?: string,
    monitorId?: string,
  ) {
    this.member(projectId, threadId);
    const now = Date.now();
    let expiresAt = now + PR_CLAIM_TTL;
    if (
      phase === 'working' &&
      (!turnId || !this.executions.activeTurnIds(threadId).includes(turnId))
    )
      throw new ConflictException('PR_EXECUTION_NOT_OBSERVED');
    if (phase === 'watching') {
      const monitor = monitorId
        ? this.db
            .select()
            .from(agentMonitors)
            .where(eq(agentMonitors.id, monitorId))
            .get()
        : undefined;
      if (
        !monitor ||
        monitor.projectId !== projectId ||
        monitor.threadId !== threadId ||
        monitor.status !== 'active' ||
        monitor.expiresAt <= now
      )
        throw new ConflictException('PR_MONITOR_NOT_ACTIVE');
      expiresAt = monitor.expiresAt;
    }
    const value = {
      projectId,
      repository: repository.toLowerCase(),
      number,
      threadId,
      phase,
      turnId: phase === 'working' ? turnId! : null,
      monitorId: phase === 'watching' ? monitorId! : null,
      expiresAt,
      updatedAt: now,
    };
    this.db
      .insert(projectPullRequestAgents)
      .values(value)
      .onConflictDoUpdate({
        target: [
          projectPullRequestAgents.projectId,
          projectPullRequestAgents.repository,
          projectPullRequestAgents.number,
          projectPullRequestAgents.threadId,
        ],
        set: value,
      })
      .run();
    return { phase, expiresAt, renewalRequired: phase === 'working' };
  }

  snapshot(projectId: string, repository: string, number: number) {
    requireProjectAccess(projectId);
    const key = and(
      eq(projectPullRequests.projectId, projectId),
      eq(projectPullRequests.repository, repository.toLowerCase()),
      eq(projectPullRequests.number, number),
    );
    const creatorId = this.db
      .select()
      .from(projectPullRequests)
      .where(key)
      .get()?.creatorThreadId;
    const visible = (threadId: string) => {
      const binding = this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, threadId))
        .get();
      return binding?.projectId === projectId && canReadThread(threadId);
    };
    const agent = (threadId: string) => ({
      threadId,
      name:
        this.metadata.getHeldThread(threadId)?.name ||
        this.metadata.getHeldThread(threadId)?.preview?.slice(0, 80) ||
        threadId,
    });
    const agents = this.db
      .select()
      .from(projectPullRequestAgents)
      .where(
        and(
          eq(projectPullRequestAgents.projectId, projectId),
          eq(projectPullRequestAgents.repository, repository.toLowerCase()),
          eq(projectPullRequestAgents.number, number),
        ),
      )
      .all()
      .filter((row) => visible(row.threadId))
      .map((row) => {
        const binding = this.db
          .select()
          .from(projectAgentThreads)
          .where(eq(projectAgentThreads.threadId, row.threadId))
          .get()!;
        let phase = row.phase;
        if (row.expiresAt <= Date.now() || binding.archivedAt !== null)
          phase = 'idle';
        const status = this.metadata.getHeldThread(row.threadId)?.status;
        if (
          phase === 'working' &&
          status?.type === 'active' &&
          status.activeFlags.some(
            (flag) =>
              flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
          )
        )
          phase = 'attention';
        if (
          row.phase === 'working' &&
          (!row.turnId ||
            !this.executions.activeTurnIds(row.threadId).includes(row.turnId))
        )
          phase = 'idle';
        if (phase === 'watching') {
          const monitor = row.monitorId
            ? this.db
                .select()
                .from(agentMonitors)
                .where(eq(agentMonitors.id, row.monitorId))
                .get()
            : undefined;
          if (
            !monitor ||
            monitor.threadId !== row.threadId ||
            monitor.projectId !== projectId ||
            !['active', 'needs_attention'].includes(monitor.status) ||
            monitor.expiresAt <= Date.now()
          )
            phase = 'idle';
          else if (monitor.status === 'needs_attention') phase = 'attention';
        }
        return { ...agent(row.threadId), phase, updatedAt: row.updatedAt };
      });
    return {
      creator: creatorId && visible(creatorId) ? agent(creatorId) : null,
      agents,
    };
  }
}
