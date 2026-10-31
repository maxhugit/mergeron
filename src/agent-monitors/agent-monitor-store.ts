/** Durable scheduling only. The runtime adapter must reauthorize before dispatch. */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  agentMonitors as monitors,
  agentMonitorRuns as runs,
  people,
  projectAgentThreads,
} from '../database/schema';
import {
  MONITOR_LIMITS,
  type CreateAgentMonitor,
  type MonitorOutcome,
} from './agent-monitor-types';

export type AgentMonitor = typeof monitors.$inferSelect;
export type AgentMonitorRun = typeof runs.$inferSelect;
export type MonitorClaim = { monitor: AgentMonitor; run: AgentMonitorRun };
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const text = (value: unknown, maximum: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new BadRequestException('MONITOR_INVALID_TEXT');
  return value.trim();
};
const integer = (value: unknown, minimum: number, maximum: number) => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new BadRequestException('MONITOR_INVALID_LIMIT');
  return value;
};

@Injectable()
export class AgentMonitorStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  create(
    projectId: string,
    threadId: string,
    personId: string,
    input: CreateAgentMonitor,
    now = Date.now(),
    options: { agentScheduled?: boolean } = {},
  ): AgentMonitor {
    const requestId = text(input.requestId, 128);
    if (!/^[\w-]+$/.test(requestId))
      throw new BadRequestException('MONITOR_INVALID_REQUEST_ID');
    const definition = {
      name: text(input.name, 120),
      instructions: text(input.instructions, 6000),
      runAt: integer(input.runAt, 0, Number.MAX_SAFE_INTEGER),
      intervalMs:
        input.intervalMs == null
          ? null
          : integer(
              input.intervalMs,
              MONITOR_LIMITS.minimumIntervalMs,
              MONITOR_LIMITS.maximumLifetimeMs,
            ),
      expiresAt: integer(input.expiresAt, 0, Number.MAX_SAFE_INTEGER),
      maxRuns: integer(input.maxRuns ?? 20, 1, 100),
      maxRunMs: integer(input.maxRunMs ?? 300_000, 30_000, 1_800_000),
      accessMode: input.accessMode ?? 'readOnly',
    };
    if (
      !['readOnly', 'workspaceWrite'].includes(definition.accessMode) ||
      definition.expiresAt <= definition.runAt
    )
      throw new BadRequestException('MONITOR_INVALID_SCHEDULE');
    const fingerprint = digest(
      JSON.stringify({ projectId, threadId, personId, ...definition }),
    );
    return this.db.transaction(
      () => {
        const owner = this.db
          .select()
          .from(people)
          .where(eq(people.id, personId))
          .get();
        const member = this.db
          .select()
          .from(projectAgentThreads)
          .where(
            and(
              eq(projectAgentThreads.threadId, threadId),
              eq(projectAgentThreads.projectId, projectId),
            ),
          )
          .get();
        if (!owner?.active || owner.role !== 'administrator' || !member)
          throw new BadRequestException('MONITOR_OWNER_OR_THREAD_UNAVAILABLE');
        const existing = this.db
          .select()
          .from(monitors)
          .where(
            and(
              eq(monitors.threadId, threadId),
              eq(monitors.requestId, requestId),
            ),
          )
          .get();
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new ConflictException('MONITOR_REQUEST_CONFLICT');
          return existing;
        }
        if (options.agentScheduled) {
          if (
            definition.maxRuns > MONITOR_LIMITS.maximumAgentRuns ||
            definition.maxRunMs > MONITOR_LIMITS.maximumAgentRunMs ||
            definition.expiresAt > now + MONITOR_LIMITS.maximumAgentLifetimeMs
          )
            throw new BadRequestException('MONITOR_AGENT_LIMIT');
          // Automatic continuation reuses one bounded plan; an agent must not
          // multiply schedules or reset a live plan with new request IDs.
          if (
            this.db
              .select({ id: monitors.id })
              .from(monitors)
              .where(
                and(
                  eq(monitors.threadId, threadId),
                  inArray(monitors.status, [
                    'active',
                    'paused',
                    'needs_attention',
                  ]),
                ),
              )
              .get()
          )
            throw new ConflictException('MONITOR_THREAD_CAPACITY');
        }
        if (
          definition.runAt < now - MONITOR_LIMITS.minimumIntervalMs ||
          definition.runAt > now + MONITOR_LIMITS.maximumLifetimeMs ||
          definition.expiresAt < now + 30_000 ||
          definition.expiresAt > now + MONITOR_LIMITS.maximumLifetimeMs
        )
          throw new BadRequestException('MONITOR_INVALID_SCHEDULE');
        const count = this.db
          .select({ value: sql<number>`count(*)` })
          .from(monitors)
          .where(
            and(
              eq(monitors.projectId, projectId),
              inArray(monitors.status, ['active', 'paused', 'needs_attention']),
            ),
          )
          .get()!.value;
        if (count >= MONITOR_LIMITS.maximumActivePerProject)
          throw new ConflictException('MONITOR_CAPACITY');
        const { runAt, ...settings } = definition;
        return this.db
          .insert(monitors)
          .values({
            id: randomUUID(),
            projectId,
            threadId,
            personId,
            requestId,
            fingerprint,
            ...settings,
            nextRunAt: runAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
      },
      { behavior: 'immediate' },
    );
  }

  get(projectId: string, id: string): AgentMonitor {
    const item = this.db
      .select()
      .from(monitors)
      .where(and(eq(monitors.projectId, projectId), eq(monitors.id, id)))
      .get();
    if (!item) throw new NotFoundException('MONITOR_NOT_FOUND');
    return item;
  }

  list(projectId: string) {
    return this.db
      .select()
      .from(monitors)
      .where(eq(monitors.projectId, projectId))
      .orderBy(desc(monitors.updatedAt), asc(monitors.id))
      .limit(100)
      .all();
  }

  history(projectId: string, id: string) {
    this.get(projectId, id);
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.monitorId, id))
      .orderBy(desc(runs.claimedAt), desc(runs.id))
      .limit(MONITOR_LIMITS.historyLimit)
      .all();
  }

  setPaused(projectId: string, id: string, paused: boolean, now = Date.now()) {
    return this.db.transaction(
      () => {
        const item = this.get(projectId, id);
        if (!paused && (item.expiresAt <= now || item.runCount >= item.maxRuns))
          throw new ConflictException('MONITOR_LIMIT_REACHED');
        // Resuming does not replay a running or uncertain delivery.
        if (
          !paused &&
          this.db
            .select()
            .from(runs)
            .where(and(eq(runs.monitorId, id), isNotNull(runs.activeThreadId)))
            .get()
        )
          throw new ConflictException('MONITOR_ALREADY_RUNNING');
        return this.db
          .update(monitors)
          .set({
            status: paused ? 'paused' : 'active',
            nextRunAt: paused ? null : now + MONITOR_LIMITS.minimumIntervalMs,
            lastReason: null,
            updatedAt: now,
          })
          .where(eq(monitors.id, id))
          .returning()
          .get();
      },
      { behavior: 'immediate' },
    );
  }

  remove(projectId: string, id: string) {
    this.db.transaction(
      () => {
        this.get(projectId, id);
        if (
          this.db
            .select()
            .from(runs)
            .where(and(eq(runs.monitorId, id), isNotNull(runs.activeThreadId)))
            .get()
        )
          throw new ConflictException('MONITOR_ALREADY_RUNNING');
        this.db.delete(monitors).where(eq(monitors.id, id)).run();
      },
      { behavior: 'immediate' },
    );
  }

  due(now = Date.now()) {
    this.db
      .update(monitors)
      .set({
        status: 'expired',
        nextRunAt: null,
        lastReason: 'MONITOR_EXPIRED',
        updatedAt: now,
      })
      .where(and(eq(monitors.status, 'active'), lte(monitors.expiresAt, now)))
      .run();
    this.db
      .update(monitors)
      .set({
        status: 'exhausted',
        nextRunAt: null,
        lastReason: 'MONITOR_RUN_LIMIT',
        updatedAt: now,
      })
      .where(
        and(
          eq(monitors.status, 'active'),
          isNotNull(monitors.nextRunAt),
          sql`${monitors.runCount} >= ${monitors.maxRuns}`,
        ),
      )
      .run();
    return this.db
      .select()
      .from(monitors)
      .where(and(eq(monitors.status, 'active'), lte(monitors.nextRunAt, now)))
      .orderBy(asc(monitors.nextRunAt), asc(monitors.id))
      .limit(20)
      .all();
  }

  claim(projectId: string, id: string, now = Date.now()): MonitorClaim | null {
    return this.db.transaction(
      () => {
        const monitor = this.get(projectId, id);
        if (
          monitor.status !== 'active' ||
          monitor.nextRunAt === null ||
          monitor.nextRunAt > now ||
          monitor.expiresAt <= now ||
          monitor.runCount >= monitor.maxRuns
        )
          return null;
        if (
          this.db
            .select()
            .from(runs)
            .where(eq(runs.activeThreadId, monitor.threadId))
            .get()
        )
          return null;
        if (this.active().length >= MONITOR_LIMITS.maximumConcurrentRuns)
          return null;
        const run = this.db
          .insert(runs)
          .values({
            id: randomUUID(),
            monitorId: id,
            activeThreadId: monitor.threadId,
            status: 'claimed',
            scheduledAt: monitor.nextRunAt,
            claimedAt: now,
            leaseUntil: now + MONITOR_LIMITS.claimLeaseMs,
          })
          .returning()
          .get();
        this.db
          .update(monitors)
          .set({ nextRunAt: null, updatedAt: now })
          .where(eq(monitors.id, id))
          .run();
        return { monitor, run };
      },
      { behavior: 'immediate' },
    );
  }

  beginDispatch(runId: string, now = Date.now()): MonitorClaim | null {
    return this.db.transaction(
      () => {
        const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run || run.status !== 'claimed' || run.leaseUntil <= now)
          return null;
        const monitor = this.db
          .select()
          .from(monitors)
          .where(eq(monitors.id, run.monitorId))
          .get();
        if (
          !monitor ||
          monitor.status !== 'active' ||
          monitor.expiresAt <= now ||
          monitor.runCount >= monitor.maxRuns
        )
          return null;
        const updated = this.db
          .update(runs)
          .set({
            status: 'dispatching',
            leaseUntil: Math.min(now + monitor.maxRunMs, monitor.expiresAt),
          })
          .where(eq(runs.id, runId))
          .returning()
          .get();
        this.db
          .update(monitors)
          .set({ runCount: monitor.runCount + 1, updatedAt: now })
          .where(eq(monitors.id, monitor.id))
          .run();
        return {
          monitor: { ...monitor, runCount: monitor.runCount + 1 },
          run: updated,
        };
      },
      { behavior: 'immediate' },
    );
  }

  bind(runId: string, turnId: string) {
    return this.db
      .update(runs)
      .set({ status: 'running', turnId: text(turnId, 128) })
      .where(and(eq(runs.id, runId), eq(runs.status, 'dispatching')))
      .returning()
      .get();
  }

  defer(runId: string, reason: string, now = Date.now()) {
    return this.db.transaction(
      () => {
        const run = this.db
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.status, 'claimed')))
          .get();
        if (!run) return;
        this.db
          .update(runs)
          .set({
            status: 'deferred',
            activeThreadId: null,
            finishedAt: now,
            reason,
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(monitors)
          .set({
            nextRunAt: now + MONITOR_LIMITS.minimumIntervalMs,
            lastReason: reason,
            updatedAt: now,
          })
          .where(
            and(eq(monitors.id, run.monitorId), eq(monitors.status, 'active')),
          )
          .run();
        this.prune(run.monitorId);
      },
      { behavior: 'immediate' },
    );
  }

  /** Hand the conversation back to its person without disabling its schedule. */
  yieldToForeground(runId: string, now = Date.now()) {
    return this.db.transaction(
      () => {
        const run = this.readRun(runId);
        if (!run?.activeThreadId) return;
        const monitor = this.monitorForRun(runId);
        if (!monitor) return;
        // A foreground input can steer the very same native turn. Once it does,
        // this reservation must not cancel that turn or accept its late report.
        this.db
          .update(runs)
          .set({
            status: 'deferred',
            activeThreadId: null,
            finishedAt: now,
            reason: 'MONITOR_USER_TAKEOVER',
            disposition: 'continue',
          })
          .where(eq(runs.id, runId))
          .run();
        // Speaking is not a pause/resume command. Preserve explicit pauses and
        // genuine attention states, and never replenish the authorized limits.
        if (monitor.status === 'active') {
          const status =
            monitor.expiresAt <= now
              ? 'expired'
              : monitor.runCount >= monitor.maxRuns
                ? 'exhausted'
                : 'active';
          this.db
            .update(monitors)
            .set({
              status,
              nextRunAt:
                status === 'active'
                  ? now +
                    Math.max(
                      MONITOR_LIMITS.minimumIntervalMs,
                      monitor.intervalMs ?? 0,
                    )
                  : null,
              lastReason: 'MONITOR_USER_TAKEOVER',
              updatedAt: now,
            })
            .where(eq(monitors.id, monitor.id))
            .run();
        }
        this.prune(monitor.id);
        return this.readRun(runId);
      },
      { behavior: 'immediate' },
    );
  }

  active() {
    return this.db
      .select()
      .from(runs)
      .where(isNotNull(runs.activeThreadId))
      .limit(100)
      .all();
  }

  readRun(id: string) {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }

  monitorForRun(id: string) {
    const run = this.readRun(id);
    return run
      ? this.db
          .select()
          .from(monitors)
          .where(eq(monitors.id, run.monitorId))
          .get()
      : undefined;
  }

  markAttention(projectId: string, id: string, reason: string) {
    return this.db
      .update(monitors)
      .set({
        status: 'needs_attention',
        nextRunAt: null,
        lastReason: reason,
        updatedAt: Date.now(),
      })
      .where(and(eq(monitors.id, id), eq(monitors.projectId, projectId)))
      .returning()
      .get();
  }

  report(
    runId: string,
    turnId: string,
    result: string,
    disposition: 'continue' | 'complete' | 'attention',
  ) {
    return this.db
      .update(runs)
      .set({ result: result.slice(0, 6000), disposition })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.turnId, turnId),
          eq(runs.status, 'running'),
        ),
      )
      .returning()
      .get();
  }

  attention(runId: string, reason: string, graceUntil?: number) {
    const run = this.readRun(runId);
    if (!run?.activeThreadId) return;
    this.db.transaction(
      () => {
        this.db
          .update(runs)
          .set({
            reason,
            disposition: 'attention',
            ...(graceUntil ? { leaseUntil: graceUntil } : {}),
          })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(monitors)
          .set({
            status: 'needs_attention',
            nextRunAt: null,
            lastReason: reason,
            updatedAt: Date.now(),
          })
          .where(eq(monitors.id, run.monitorId))
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  /** Keep the reservation until native idleness is established or a human takes over. */
  quarantine(runId: string, reason: string, now = Date.now()) {
    const run = this.readRun(runId);
    if (!run?.activeThreadId || run.status === 'claimed') return;
    this.db.transaction(
      () => {
        this.db
          .update(runs)
          .set({ status: 'uncertain', reason, disposition: 'attention' })
          .where(eq(runs.id, runId))
          .run();
        this.db
          .update(monitors)
          .set({
            status: 'needs_attention',
            nextRunAt: null,
            lastReason: reason,
            updatedAt: now,
          })
          .where(eq(monitors.id, run.monitorId))
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  releaseQuarantine(runId: string, now = Date.now()) {
    return this.db
      .update(runs)
      .set({ activeThreadId: null, finishedAt: now })
      .where(and(eq(runs.id, runId), eq(runs.status, 'uncertain')))
      .returning()
      .get();
  }

  stop(projectId: string, id: string, now = Date.now()) {
    this.get(projectId, id);
    return this.db
      .update(monitors)
      .set({ status: 'completed', nextRunAt: null, updatedAt: now })
      .where(eq(monitors.id, id))
      .returning()
      .get();
  }

  finish(
    runId: string,
    turnId: string | null,
    outcome: MonitorOutcome,
    now = Date.now(),
  ) {
    return this.db.transaction(
      () => {
        const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
        if (
          !run ||
          !run.activeThreadId ||
          run.turnId !== turnId ||
          !['dispatching', 'running'].includes(run.status)
        )
          return null;
        const monitor = this.db
          .select()
          .from(monitors)
          .where(eq(monitors.id, run.monitorId))
          .get();
        if (!monitor) return null;
        const result = outcome.result.trim().slice(0, 6000);
        const resultDigest = digest(result);
        const disposition =
          outcome.disposition ?? (outcome.success ? 'continue' : 'attention');
        const changed = resultDigest !== monitor.lastResultDigest;
        const completed = this.db
          .update(runs)
          .set({
            status: outcome.success ? 'completed' : 'failed',
            activeThreadId: null,
            finishedAt: now,
            result,
            reason: outcome.reason ?? null,
            disposition,
            changed,
          })
          .where(eq(runs.id, runId))
          .returning()
          .get();
        let status = monitor.status;
        if (status === 'active')
          status =
            !outcome.success || disposition === 'attention'
              ? 'needs_attention'
              : disposition === 'complete' || monitor.intervalMs === null
                ? 'completed'
                : monitor.expiresAt <= now
                  ? 'expired'
                  : monitor.runCount >= monitor.maxRuns
                    ? 'exhausted'
                    : 'active';
        this.db
          .update(monitors)
          .set({
            status,
            nextRunAt: status === 'active' ? now + monitor.intervalMs! : null,
            lastResultDigest: resultDigest,
            lastReason: outcome.reason ?? null,
            updatedAt: now,
          })
          .where(eq(monitors.id, monitor.id))
          .run();
        this.prune(monitor.id);
        return completed;
      },
      { behavior: 'immediate' },
    );
  }

  /** Expired pre-send claims may be retried; an uncertain send is never replayed. */
  recover(now = Date.now()) {
    for (const run of this.active().filter((item) => item.leaseUntil <= now)) {
      if (run.status === 'claimed')
        this.defer(run.id, 'MONITOR_CLAIM_EXPIRED', now);
      else this.quarantine(run.id, 'MONITOR_OUTCOME_UNCERTAIN', now);
    }
  }

  private prune(monitorId: string) {
    const old = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.monitorId, monitorId), isNull(runs.activeThreadId)))
      .orderBy(desc(runs.claimedAt), desc(runs.id))
      .limit(1000)
      .offset(MONITOR_LIMITS.historyLimit)
      .all();
    if (old.length)
      this.db
        .delete(runs)
        .where(
          inArray(
            runs.id,
            old.map((item) => item.id),
          ),
        )
        .run();
  }
}
