/** Server-side wakeups reuse authenticated threads; no shell loops or cached cookies. */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { accessContext } from '../auth/access-context';
import { IdentityService } from '../auth/identity.service';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { projectAgentThreads } from '../database/schema';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { CodexService } from '../codex/codex.service';
import type { ServerNotification } from '../codex/codex-schema';
import { ThreadsService } from '../threads/threads.service';
import { ThreadSettingsObserverService } from '../threads/thread-settings-observer.service';
import { ThreadExecutionInventoryService } from '../threads/thread-execution-inventory.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { InternalMcpService } from '../internal-mcp/internal-mcp.service';
import { PushService } from '../push/push.service';
import {
  AgentMonitorStore,
  type AgentMonitor,
  type AgentMonitorRun,
} from './agent-monitor-store';

@Injectable()
export class AgentMonitorRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentMonitorRuntime.name);
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private stopped = false;
  private readonly summaries = new Map<string, string>();
  private readonly probes = new Map<string, number>();
  private readonly foregroundTransfers = new Set<string>();
  private readonly releaseForeground: () => void;
  private readonly releaseLifecycle: () => void;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    readonly store: AgentMonitorStore,
    private readonly identities: IdentityService,
    private readonly manager: CodexProcessManager,
    private readonly codex: CodexService,
    private readonly threads: ThreadsService,
    private readonly settings: ThreadSettingsObserverService,
    private readonly inventory: ThreadExecutionInventoryService,
    private readonly pending: PendingApprovalsService,
    private readonly mcp: InternalMcpService,
    @Optional() private readonly push?: PushService,
  ) {
    this.releaseForeground = threads.onForegroundInput((id) =>
      this.yieldToForeground(id),
    );
    this.releaseLifecycle = manager.addLifecycleListener(() => {
      if (this.stopped) return;
      this.summaries.clear();
      this.probes.clear();
      try {
        for (const run of store.active())
          if (run.status !== 'claimed') {
            store.quarantine(run.id, 'MONITOR_ENGINE_RESTART');
            this.notify(run);
          }
      } catch {
        this.logger.warn(
          'Monitor recovery needs review; no action will be replayed.',
        );
      }
    });
    manager.addListener('notification', (note: ServerNotification) => {
      if (this.stopped) return;
      try {
        this.observe(note);
      } catch {
        this.logger.warn(
          'A monitor event could not be recorded; no action will be replayed.',
        );
      }
    });
  }

  onModuleInit() {
    // No catch-up loop: at most one future check per schedule after recovery.
    for (const run of this.store.active())
      if (run.status !== 'claimed') {
        this.store.quarantine(run.id, 'MONITOR_BACKEND_RESTART');
        this.notify(run);
      }
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.releaseForeground();
    this.releaseLifecycle();
    await this.flight;
  }

  private notify(run: AgentMonitorRun) {
    const monitor = this.store.monitorForRun(run.id);
    if (!monitor) return;
    try {
      // Existing personal preferences, rights, deduplication and delivery
      // retries apply. No instructions, summaries, credentials or URLs in push.
      this.push?.enqueue('completed', monitor.threadId, `monitor:${run.id}`);
    } catch {
      this.logger.warn('A monitor notification could not be queued.');
    }
  }

  authorize(monitor: AgentMonitor) {
    const identity = this.identities.resolvePerson(monitor.personId);
    this.identities.requireAdministrator(identity);
    this.identities.requireProject(identity, monitor.projectId);
    this.identities.requireThread(identity, monitor.threadId);
    if (
      !this.db
        .select()
        .from(projectAgentThreads)
        .where(
          and(
            eq(projectAgentThreads.threadId, monitor.threadId),
            eq(projectAgentThreads.projectId, monitor.projectId),
          ),
        )
        .get()
    )
      throw new ForbiddenException('MONITOR_PROJECT_CHANGED');
    return identity;
  }

  accessForSchedule(threadId: string): 'readOnly' | 'workspaceWrite' {
    const policy = this.settings.readSecurityPolicy(threadId);
    if (!policy.observed || !policy.sandboxPolicy || !policy.approvalPolicy)
      throw new ConflictException('MONITOR_POLICY_UNKNOWN');
    const type = policy.sandboxPolicy.type;
    if (type !== 'readOnly' && type !== 'workspaceWrite')
      throw new ForbiddenException('MONITOR_POLICY_EXCEEDS_GRANT');
    return type;
  }

  async verifyIdleForResume(monitor: AgentMonitor) {
    if (!this.manager.getClient())
      throw new ConflictException('MONITOR_ENGINE_UNAVAILABLE');
    const identity = this.authorize(monitor);
    await accessContext.run(
      { identity, identities: this.identities },
      async () => {
        const response = await this.threads.readThread(monitor.threadId);
        if (
          this.inventory.has(monitor.threadId) ||
          this.pending.listPending([monitor.threadId]).length ||
          !['idle', 'notLoaded'].includes(response.thread.status.type)
        )
          throw new ConflictException('MONITOR_AGENT_BUSY');
        this.authorize(monitor);
        for (const run of this.store
          .active()
          .filter(
            (item) =>
              item.monitorId === monitor.id && item.status === 'uncertain',
          ))
          this.store.releaseQuarantine(run.id);
      },
    );
  }

  private assertIdle(monitor: AgentMonitor) {
    if (this.stopped || !this.manager.getClient())
      throw new ConflictException('MONITOR_ENGINE_UNAVAILABLE');
    this.authorize(monitor);
    if (
      this.foregroundTransfers.has(monitor.threadId) ||
      this.inventory.has(monitor.threadId) ||
      this.pending.listPending([monitor.threadId]).length
    )
      throw new ConflictException('MONITOR_AGENT_BUSY');
    const latest = this.store.get(monitor.projectId, monitor.id);
    if (latest.status !== 'active' || latest.expiresAt <= Date.now())
      throw new ConflictException('MONITOR_NOT_ACTIVE');
    // Never change a thread's security preferences to run unattended work.
    // A read-only grant cannot run a currently writable or unrestricted thread.
    const policy = this.settings.readSecurityPolicy(monitor.threadId);
    if (!policy.observed || !policy.sandboxPolicy || !policy.approvalPolicy)
      throw new ConflictException('MONITOR_POLICY_UNKNOWN');
    const type = policy.sandboxPolicy.type;
    if (
      type !== 'readOnly' &&
      (type !== 'workspaceWrite' || monitor.accessMode !== 'workspaceWrite')
    )
      throw new ForbiddenException('MONITOR_POLICY_EXCEEDS_GRANT');
  }

  tick(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.cycle()
      .catch(() => {
        this.logger.warn(
          'Monitor scheduling could not complete; retained sends will not be replayed.',
        );
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }

  private async cycle() {
    if (this.stopped) return;
    const due = this.store.due();
    if (!this.manager.getClient()) return;
    const active = this.store.active();
    for (const threadId of this.foregroundTransfers)
      if (!active.some((run) => run.activeThreadId === threadId))
        this.foregroundTransfers.delete(threadId);
    for (const run of active) {
      if (this.stopped) return;
      await this.reconcile(run);
    }
    for (const monitor of due) {
      if (this.stopped) return;
      if (
        this.inventory.has(monitor.threadId) ||
        this.pending.listPending([monitor.threadId]).length
      )
        continue;
      try {
        this.authorize(monitor);
      } catch {
        this.store.markAttention(
          monitor.projectId,
          monitor.id,
          'MONITOR_ACCESS_REVOKED',
        );
        continue;
      }
      const claim = this.store.claim(monitor.projectId, monitor.id);
      if (claim) await this.dispatch(claim.monitor, claim.run);
    }
  }

  private async dispatch(monitor: AgentMonitor, run: AgentMonitorRun) {
    try {
      const identity = this.authorize(monitor);
      await accessContext.run(
        { identity, identities: this.identities },
        async () => {
          const read = await this.threads.readThread(monitor.threadId);
          if (
            read.thread.status.type === 'active' ||
            read.thread.status.type === 'systemError'
          )
            throw new ConflictException('MONITOR_AGENT_BUSY');
          if (read.thread.parentThreadId || read.thread.ephemeral)
            throw new ForbiddenException('MONITOR_THREAD_UNSUPPORTED');
          const opened = await this.threads.resumeThread(monitor.threadId, {
            recordActive: false,
          });
          const current = await this.threads.readThread(monitor.threadId);
          if (
            opened.mode !== 'writable' ||
            current.thread.parentThreadId ||
            current.thread.ephemeral ||
            current.thread.status.type !== 'idle'
          )
            throw new ConflictException('MONITOR_AGENT_BUSY');
          this.assertIdle(monitor);
          const response = await this.threads.startTurn(
            {
              threadId: monitor.threadId,
              turnTrigger: 'automation',
              input: [
                {
                  type: 'text',
                  text: `<mergeron_agent_monitor>\nScheduled check: ${JSON.stringify({ monitorId: monitor.id, runId: run.id, name: monitor.name, instructions: monitor.instructions, expiresAt: monitor.expiresAt, remainingChecks: monitor.maxRuns - monitor.runCount, accessMode: monitor.accessMode })}\nContinue only this explicitly requested monitoring task. This wakeup grants no new permissions and does not authorize any merge, publication or other write by itself. Respect the saved human scope and every approval. Do not create other monitors, increase limits or retry an uncertain action. Check the current external state; do not replay earlier actions. Use agent_monitor_report with a concise summary and continue, complete when the objective is reached, or attention when a human decision is required.\n</mergeron_agent_monitor>`,
                  text_elements: [],
                },
              ],
            },
            {
              assertIdle: () => this.assertIdle(monitor),
              beforeSend: () => {
                this.assertIdle(monitor);
                if (!this.store.beginDispatch(run.id))
                  throw new ConflictException('MONITOR_NOT_ACTIVE');
              },
            },
          );
          if (this.stopped) return;
          // A native start/completion notification may precede the RPC response.
          if (this.store.readRun(run.id)?.status === 'dispatching')
            this.store.bind(run.id, response.turn.id);
        },
      );
    } catch (error) {
      if (this.stopped) return;
      const latest = this.store.readRun(run.id);
      if (latest?.status === 'claimed') {
        const reason =
          error instanceof Error && /^MONITOR_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'MONITOR_NOT_DISPATCHED';
        this.store.defer(run.id, reason);
        if (
          error instanceof ForbiddenException ||
          reason.startsWith('MONITOR_POLICY')
        )
          this.store.markAttention(monitor.projectId, monitor.id, reason);
      } else if (latest?.status === 'dispatching') {
        this.store.quarantine(run.id, 'MONITOR_DISPATCH_UNCERTAIN');
      }
      if (
        this.store.get(monitor.projectId, monitor.id).status ===
        'needs_attention'
      )
        this.notify(run);
    }
  }

  private yieldToForeground(threadId: string) {
    // Invalidate timer ownership before any fallible persistence. A temporary
    // SQLite write failure must never let a stale deadline cancel a human turn.
    this.foregroundTransfers.add(threadId);
    try {
      const owned = this.store
        .active()
        .filter((item) => item.activeThreadId === threadId);
      for (const run of owned) {
        this.mcp.revoke(threadId);
        this.store.yieldToForeground(run.id);
        this.summaries.delete(run.id);
        this.probes.delete(run.id);
      }
      this.foregroundTransfers.delete(threadId);
      return owned.length > 0;
    } catch {
      this.mcp.revoke(threadId);
      this.logger.warn(
        'A foreground handover will be persisted later; automatic work remains deferred.',
      );
      return true;
    }
  }

  private observe(note: ServerNotification) {
    if (!('threadId' in note.params)) return;
    const threadId = note.params.threadId;
    if (typeof threadId !== 'string') return;
    if (this.foregroundTransfers.has(threadId)) return;
    const run = this.store
      .active()
      .find((item) => item.activeThreadId === threadId);
    if (!run) return;
    if (note.method === 'turn/started' && run.status === 'dispatching') {
      this.store.bind(run.id, note.params.turn.id);
      return;
    }
    if (
      note.method === 'item/completed' &&
      note.params.turnId === run.turnId &&
      note.params.item.type === 'agentMessage'
    )
      this.summaries.set(run.id, note.params.item.text.slice(0, 6000));
    if (
      note.method === 'turn/completed' &&
      note.params.turn.id === run.turnId &&
      run.status === 'running'
    ) {
      const finished = this.store.finish(run.id, run.turnId, {
        success: note.params.turn.status === 'completed',
        result:
          run.result ||
          this.summaries.get(run.id) ||
          'Scheduled check finished.',
        disposition: run.disposition,
        reason:
          run.reason ??
          (note.params.turn.status === 'completed'
            ? undefined
            : 'MONITOR_TURN_INTERRUPTED'),
      });
      if (
        finished &&
        (finished.changed ||
          finished.disposition !== 'continue' ||
          finished.status === 'failed')
      )
        this.notify(finished);
      this.summaries.delete(run.id);
      this.probes.delete(run.id);
    }
  }

  private async reconcile(run: AgentMonitorRun) {
    const now = Date.now();
    if (
      run.activeThreadId &&
      this.foregroundTransfers.has(run.activeThreadId)
    ) {
      this.store.yieldToForeground(run.id);
      this.foregroundTransfers.delete(run.activeThreadId);
      this.summaries.delete(run.id);
      this.probes.delete(run.id);
      return;
    }
    if (run.status === 'claimed') {
      if (run.leaseUntil <= now)
        this.store.defer(run.id, 'MONITOR_CLAIM_EXPIRED');
      return;
    }
    if (run.status === 'uncertain') {
      if ((this.probes.get(run.id) ?? 0) + 60_000 > now) return;
      this.probes.set(run.id, now);
      try {
        const response = await this.codex.request<{
          thread: { status: { type: string } };
        }>('thread/read', {
          threadId: run.activeThreadId,
          includeTurns: false,
        });
        if (
          !this.stopped &&
          !this.inventory.has(run.activeThreadId!) &&
          ['idle', 'notLoaded'].includes(response.thread.status.type)
        ) {
          this.store.releaseQuarantine(run.id);
          this.probes.delete(run.id);
        }
      } catch {
        /* Unknown is not idle: keep the reservation and require review. */
      }
      return;
    }
    const monitor = this.store.monitorForRun(run.id);
    if (!monitor) return;
    let authorized = true;
    try {
      this.authorize(monitor);
    } catch {
      authorized = false;
    }
    const reason = !authorized
      ? 'MONITOR_ACCESS_REVOKED'
      : run.leaseUntil <= now
        ? 'MONITOR_TIMEOUT'
        : null;
    if (
      ![
        'MONITOR_TIMEOUT',
        'MONITOR_ACCESS_REVOKED',
        'MONITOR_APPROVAL_REQUIRED',
      ].includes(run.reason ?? '') &&
      this.pending
        .listPending([monitor.threadId])
        .some((request) => request.turnId === run.turnId)
    )
      this.store.attention(run.id, 'MONITOR_APPROVAL_REQUIRED');
    if (!reason) return;
    if (
      run.reason === 'MONITOR_TIMEOUT' ||
      run.reason === 'MONITOR_ACCESS_REVOKED'
    ) {
      if (run.leaseUntil <= now)
        this.store.quarantine(run.id, 'MONITOR_STOP_UNCONFIRMED');
      return;
    }
    this.store.attention(run.id, reason, now + 60_000);
    this.notify(run);
    if (!run.turnId) {
      this.store.quarantine(run.id, 'MONITOR_DISPATCH_UNCERTAIN');
      return;
    }
    // Cancellation is limited to the exact turn admitted by this monitor. It
    // cannot approve a request or execute new work under a revoked identity.
    this.mcp.revoke(monitor.threadId);
    try {
      await this.codex.request('turn/interrupt', {
        threadId: monitor.threadId,
        turnId: run.turnId,
      });
    } catch {
      this.store.quarantine(run.id, 'MONITOR_STOP_UNCONFIRMED');
    }
  }
}
