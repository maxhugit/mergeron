import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { Subscription } from 'rxjs';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  pushSubscriptions,
  pushEvents,
  pushDeliveries,
  pendingServerRequests,
  projectAgentThreads,
  conversationOwners,
  conversationBranchEdges,
  agentMonitors,
  agentMonitorRuns,
} from '../database/schema';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { PushTransportService } from './push-transport.service';
import {
  pushPerson,
  validateSubscription,
  validatePushPreferences,
} from './push-validation';

type Device = typeof pushSubscriptions.$inferSelect;
type Kind = typeof pushDeliveries.$inferSelect.kind;
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const safeDevice = ({
  id,
  label,
  language,
  completed,
  approvals,
  questions,
  createdAt,
  updatedAt,
}: Device) => ({
  id,
  label,
  language,
  completed,
  approvals,
  questions,
  createdAt,
  updatedAt,
});

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private attention?: Subscription;
  private busy = false;
  private stopped = false;
  private readonly ephemeral = new Set<string>();
  private readonly notification = (note: ServerNotification) => {
    if (this.stopped) return;
    try {
      if (note.method === 'thread/started' && note.params.thread.ephemeral) {
        if (this.ephemeral.size >= 1024) {
          for (const oldest of this.ephemeral) {
            this.ephemeral.delete(oldest);
            break;
          }
        }
        this.ephemeral.add(note.params.thread.id);
      }
      if (note.method === 'thread/deleted') {
        this.ephemeral.delete(note.params.threadId);
        this.db
          .update(pushDeliveries)
          .set({ status: 'dropped' })
          .where(
            and(
              eq(pushDeliveries.threadId, note.params.threadId),
              inArray(pushDeliveries.status, ['pending', 'sending']),
            ),
          )
          .run();
      }
      if (
        note.method === 'turn/completed' &&
        note.params.turn.status === 'completed'
      ) {
        const scheduled = this.db
          .select({ reason: agentMonitorRuns.reason })
          .from(agentMonitorRuns)
          .innerJoin(
            agentMonitors,
            eq(agentMonitorRuns.monitorId, agentMonitors.id),
          )
          .where(
            and(
              eq(agentMonitorRuns.turnId, note.params.turn.id),
              eq(agentMonitors.threadId, note.params.threadId),
            ),
          )
          .get();
        // Monitor summaries have their own change-sensitive notification path.
        // A steered turn belongs to the person again and must keep normal push.
        if (scheduled && scheduled.reason !== 'MONITOR_USER_TAKEOVER') return;
        this.enqueue(
          'completed',
          note.params.threadId,
          `turn:${note.params.threadId}:${note.params.turn.id}`,
        );
      }
    } catch {
      this.logger.warn(
        'Unable to queue a push event. No conversation content was logged.',
      );
    }
  };
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly identities: IdentityService,
    private readonly manager: CodexProcessManager,
    private readonly pending: PendingApprovalsService,
    private readonly metadata: ThreadMetadataService,
    private readonly deletion: ThreadDeletionRegistryService,
    private readonly transport: PushTransportService,
  ) {
    manager.addListener('notification', this.notification);
  }
  onModuleInit() {
    this.attention = this.pending.requests.subscribe((request) => {
      try {
        if (request.status === 'pending')
          this.enqueue(
            request.method === 'item/tool/requestUserInput'
              ? 'questions'
              : 'approvals',
            request.threadId,
            `request:${request.instanceId}`,
            request.instanceId,
          );
      } catch {
        this.logger.warn('Unable to queue a push attention event.');
      }
    });
    this.timer = setInterval(() => {
      void this.drain().catch(() =>
        this.logger.warn(
          'Push delivery paused; retained requests will be retried.',
        ),
      );
    }, 5_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.attention?.unsubscribe();
  }
  status(identity: PlatformIdentity) {
    const personId = pushPerson(identity);
    return {
      configured: !!this.transport.publicKey(),
      publicKey: this.transport.publicKey(),
      devices: this.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.personId, personId))
        .all()
        .map((device) => {
          const test = this.db
            .select({ status: pushDeliveries.status })
            .from(pushDeliveries)
            .where(
              and(
                eq(pushDeliveries.subscriptionId, device.id),
                eq(pushDeliveries.kind, 'test'),
              ),
            )
            .orderBy(desc(pushDeliveries.createdAt))
            .limit(1)
            .get();
          return {
            ...safeDevice(device),
            lastTestStatus:
              test?.status === 'sending' ? 'pending' : (test?.status ?? null),
          };
        }),
    };
  }
  subscribe(identity: PlatformIdentity, body: unknown) {
    const personId = pushPerson(identity);
    if (!this.transport.publicKey())
      throw new ServiceUnavailableException('pushNotConfigured');
    const device = validateSubscription(body);
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, device.endpoint))
        .get();
      // Never let a different account take over another person’s push capability.
      if (existing && existing.personId !== personId)
        throw new ConflictException('pushDeviceAlreadyLinked');
      if (
        existing &&
        (existing.auth !== device.auth || existing.p256dh !== device.p256dh)
      )
        throw new ConflictException('pushInvalidSubscription');
      if (
        !existing &&
        this.db
          .select({ id: pushSubscriptions.id })
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.personId, personId))
          .all().length >= 20
      )
        throw new BadRequestException('pushDeviceLimit');
      const id = existing?.id ?? randomUUID();
      this.db
        .insert(pushSubscriptions)
        .values({ id, personId, ...device, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: pushSubscriptions.id,
          set: {
            label: device.label,
            language: device.language,
            updatedAt: now,
          },
        })
        .run();
      return safeDevice(this.device(personId, id));
    });
  }
  private device(personId: string, id: string) {
    const row = this.db
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.id, id),
          eq(pushSubscriptions.personId, personId),
        ),
      )
      .get();
    if (!row) throw new NotFoundException('pushDeviceNotFound');
    return row;
  }
  preferences(identity: PlatformIdentity, id: string, input: unknown) {
    const personId = pushPerson(identity);
    this.device(personId, id);
    const values = validatePushPreferences(input);
    this.db
      .update(pushSubscriptions)
      .set({ ...values, updatedAt: Date.now() })
      .where(
        and(
          eq(pushSubscriptions.id, id),
          eq(pushSubscriptions.personId, personId),
        ),
      )
      .run();
    return safeDevice(this.device(personId, id));
  }
  remove(identity: PlatformIdentity, id: string) {
    const personId = pushPerson(identity);
    this.device(personId, id);
    this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.id, id),
          eq(pushSubscriptions.personId, personId),
        ),
      )
      .run();
    return { removed: true };
  }
  test(identity: PlatformIdentity, id: string) {
    const personId = pushPerson(identity);
    const device = this.device(personId, id);
    if (!this.transport.publicKey())
      throw new ServiceUnavailableException('pushNotConfigured');
    const now = Date.now();
    if (device.lastTestAt && now - device.lastTestAt < 30_000)
      throw new BadRequestException('pushTestRateLimited');
    this.db
      .update(pushSubscriptions)
      .set({ lastTestAt: now })
      .where(eq(pushSubscriptions.id, id))
      .run();
    this.insertDelivery(
      device,
      'test',
      `test:${randomUUID()}`,
      null,
      null,
      now,
    );
    return { queued: true };
  }
  private knownThread(id: string) {
    return (
      !this.ephemeral.has(id) &&
      (this.metadata.getHeldThread(id)?.ephemeral === false ||
        !!this.db
          .select()
          .from(projectAgentThreads)
          .where(eq(projectAgentThreads.threadId, id))
          .get() ||
        !!this.db
          .select()
          .from(conversationOwners)
          .where(
            and(
              eq(conversationOwners.kind, 'agent'),
              eq(conversationOwners.conversationId, id),
            ),
          )
          .get() ||
        !!this.db
          .select()
          .from(conversationBranchEdges)
          .where(eq(conversationBranchEdges.childThreadId, id))
          .get())
    );
  }
  private allowed(device: Device, kind: Kind, threadId: string | null) {
    const identity = this.identities.resolvePerson(device.personId);
    if (!identity.active || identity.kind !== 'person' || !identity.role)
      return false;
    if (kind === 'test') return true;
    if (
      !threadId ||
      !device[kind] ||
      !this.knownThread(threadId) ||
      this.deletion.isDeleting(threadId)
    )
      return false;
    // The current platform reserves all agent execution/approval responses to admins.
    if (kind !== 'completed' && identity.role !== 'administrator') return false;
    return this.identities.canReadThread(identity, threadId);
  }
  enqueue(
    kind: Exclude<Kind, 'test'>,
    threadId: string,
    eventKey: string,
    requestInstanceId: string | null = null,
  ) {
    if (
      !safeId(threadId) ||
      !this.knownThread(threadId) ||
      this.deletion.isDeleting(threadId)
    )
      return;
    const now = Date.now();
    this.db.transaction(() => {
      if (
        !this.db
          .insert(pushEvents)
          .values({ eventKey, createdAt: now })
          .onConflictDoNothing()
          .returning()
          .get()
      )
        return;
      for (const device of this.db.select().from(pushSubscriptions).all()) {
        if (!this.allowed(device, kind, threadId)) continue;
        this.insertDelivery(
          device,
          kind,
          eventKey,
          threadId,
          requestInstanceId,
          now,
        );
      }
    });
  }
  private insertDelivery(
    device: Device,
    kind: Kind,
    eventKey: string,
    threadId: string | null,
    requestInstanceId: string | null,
    now: number,
  ) {
    this.db
      .insert(pushDeliveries)
      .values({
        id: randomUUID(),
        subscriptionId: device.id,
        kind,
        eventKey,
        threadId,
        requestInstanceId,
        createdAt: now,
        expiresAt: now + (kind === 'completed' ? 3600_000 : 900_000),
        nextAttemptAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
  async drain() {
    if (this.busy || this.stopped || !this.transport.publicKey()) return;
    this.busy = true;
    try {
      const now = Date.now();
      this.db
        .update(pushDeliveries)
        .set({ status: 'pending' })
        .where(
          and(
            eq(pushDeliveries.status, 'sending'),
            lte(pushDeliveries.leaseAt, now - 60_000),
          ),
        )
        .run();
      this.db
        .delete(pushDeliveries)
        .where(lte(pushDeliveries.expiresAt, now - 7 * 86400_000))
        .run();
      this.db
        .delete(pushEvents)
        .where(lte(pushEvents.createdAt, now - 7 * 86400_000))
        .run();
      const due = this.db
        .select()
        .from(pushDeliveries)
        .where(
          and(
            eq(pushDeliveries.status, 'pending'),
            lte(pushDeliveries.nextAttemptAt, now),
          ),
        )
        .limit(16)
        .all();
      for (const row of due) {
        if (this.stopped) break;
        const device = this.db
          .select()
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.id, row.subscriptionId))
          .get();
        const request = row.requestInstanceId
          ? this.db
              .select()
              .from(pendingServerRequests)
              .where(
                eq(pendingServerRequests.instanceId, row.requestInstanceId),
              )
              .get()
          : null;
        if (
          !device ||
          row.expiresAt <= Date.now() ||
          row.attempts >= 4 ||
          !this.allowed(device, row.kind, row.threadId) ||
          (row.requestInstanceId && request?.status !== 'pending')
        ) {
          this.db
            .update(pushDeliveries)
            .set({ status: 'dropped' })
            .where(eq(pushDeliveries.id, row.id))
            .run();
          continue;
        }
        const claimed = this.db
          .update(pushDeliveries)
          .set({
            status: 'sending',
            leaseAt: Date.now(),
            attempts: sql`${pushDeliveries.attempts} + 1`,
          })
          .where(
            and(
              eq(pushDeliveries.id, row.id),
              eq(pushDeliveries.status, 'pending'),
            ),
          )
          .returning()
          .get();
        if (!claimed) continue;
        try {
          await this.transport.send(
            device,
            {
              version: 1,
              id: row.id,
              kind: row.kind,
              threadId: row.threadId,
              language: device.language,
            },
            Math.ceil((row.expiresAt - Date.now()) / 1000),
            createHash('sha256')
              .update(row.id)
              .digest('base64url')
              .slice(0, 32),
          );
          this.db
            .update(pushDeliveries)
            .set({ status: 'sent' })
            .where(
              and(
                eq(pushDeliveries.id, row.id),
                eq(pushDeliveries.status, 'sending'),
              ),
            )
            .run();
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410)
            this.db
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.id, device.id))
              .run();
          else
            this.db
              .update(pushDeliveries)
              .set({
                status:
                  claimed.attempts >= 4 ||
                  (status &&
                    status >= 400 &&
                    status < 500 &&
                    ![408, 429].includes(status))
                    ? 'dropped'
                    : 'pending',
                nextAttemptAt:
                  Date.now() + Math.min(120_000, 10_000 * 3 ** row.attempts),
              })
              .where(
                and(
                  eq(pushDeliveries.id, row.id),
                  eq(pushDeliveries.status, 'sending'),
                ),
              )
              .run();
          // Never log endpoints, payloads, provider response bodies or keys.
          this.logger.warn(
            'Push delivery failed; check device permission, connectivity and egress policy.',
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
