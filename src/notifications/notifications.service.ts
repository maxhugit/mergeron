import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Subscription } from 'rxjs';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  inboxNotifications as inbox,
  inboxPreferences as preferences,
  people,
  agentMonitorRuns,
  agentMonitors,
  pendingServerRequests,
  projectAgentThreads,
  projects,
} from '../database/schema';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { pushPerson } from '../push/push-validation';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';

const DAY = 86400000;
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private attention?: Subscription;
  private stopped = false;
  private ephemeral = new Set<string>();
  private readonly note = (note: ServerNotification) => {
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
      if (note.method === 'thread/deleted')
        this.ephemeral.delete(note.params.threadId);
      if (
        note.method === 'turn/completed' &&
        !this.ephemeral.has(note.params.threadId)
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
        if (scheduled && scheduled.reason !== 'MONITOR_USER_TAKEOVER') return;
        const status = note.params.turn.status;
        if (status === 'completed' || status === 'failed')
          this.recordThread(
            note.params.threadId,
            status === 'completed' ? 'completed' : 'error',
            `turn:${note.params.threadId}:${note.params.turn.id}`,
          );
      }
    } catch {
      this.logger.warn(
        'Unable to record inbox event; conversation content was not logged.',
      );
    }
  };
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly identities: IdentityService,
    private readonly manager: CodexProcessManager,
    private readonly pending: PendingApprovalsService,
  ) {}
  onModuleInit() {
    this.manager.addListener('notification', this.note);
    this.attention = this.pending.requests.subscribe((r) => {
      if (r.status !== 'pending') return;
      try {
        this.recordThread(
          r.threadId,
          r.method === 'item/tool/requestUserInput' ? 'question' : 'approval',
          `request:${r.instanceId}`,
        );
      } catch {
        this.logger.warn('Unable to record attention event.');
      }
    });
    for (const r of this.db
      .select()
      .from(pendingServerRequests)
      .where(eq(pendingServerRequests.status, 'pending'))
      .all()) {
      if (r.instanceId)
        this.recordThread(
          r.threadId,
          r.method === 'item/tool/requestUserInput' ? 'question' : 'approval',
          `request:${r.instanceId}`,
        );
    }
    this.cleanup();
    this.timer = setInterval(() => {
      try {
        this.cleanup();
      } catch {
        this.logger.warn('Inbox cleanup failed.');
      }
    }, 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.attention?.unsubscribe();
    this.stopped = true;
  }
  cleanup() {
    this.db.run(
      sql`delete from ${inbox} where ${inbox.createdAt} <= ${Date.now()} - 86400000 * coalesce((select retention_days from inbox_preferences where person_id = ${inbox.personId}),7)`,
    );
  }
  recordThread(threadId: string, kind: string, eventKey: string) {
    const thread = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    if (!thread) return;
    for (const person of this.db
      .select()
      .from(people)
      .where(eq(people.active, true))
      .all()) {
      const identity = this.identities.resolvePerson(person.id);
      if (
        this.identities.canReadProject(identity, thread.projectId) &&
        this.identities.canReadThread(identity, threadId)
      )
        this.db
          .insert(inbox)
          .values({
            id: randomUUID(),
            personId: person.id,
            projectId: thread.projectId,
            threadId,
            kind,
            message: '',
            eventKey,
            createdAt: Date.now(),
          })
          .onConflictDoNothing()
          .run();
    }
  }
  private visible(identity: PlatformIdentity) {
    const id = pushPerson(identity);
    const days = this.preference(identity).retentionDays;
    return this.db
      .select({ notification: inbox, projectName: projects.name })
      .from(inbox)
      .leftJoin(projects, eq(inbox.projectId, projects.id))
      .where(
        and(
          eq(inbox.personId, id),
          sql`${inbox.createdAt} > ${Date.now() - days * DAY}`,
        ),
      )
      .orderBy(desc(inbox.createdAt), desc(inbox.id))
      .all()
      .filter(
        ({ notification: n }) =>
          (!n.projectId ||
            this.identities.canReadProject(identity, n.projectId)) &&
          (!n.threadId || this.identities.canReadThread(identity, n.threadId)),
      );
  }
  list(identity: PlatformIdentity, filter: string = 'all', cursor?: string) {
    if (!['all', 'read', 'unread'].includes(filter))
      throw new BadRequestException('Invalid notification filter');
    const visible = this.visible(identity);
    let rows = visible.filter(
      (r) =>
        filter === 'all' ||
        (filter === 'read') === (r.notification.readAt !== null),
    );
    if (cursor) {
      const index = rows.findIndex((r) => r.notification.id === cursor);
      if (index < 0)
        throw new BadRequestException('Invalid notification cursor');
      rows = rows.slice(index + 1);
    }
    const page = rows.slice(0, 100);
    return {
      items: page.map((r) => ({
        ...r.notification,
        projectName: r.projectName,
      })),
      unread: visible.filter((r) => r.notification.readAt === null).length,
      nextCursor: rows.length > 100 ? page.at(-1)!.notification.id : null,
    };
  }
  read(identity: PlatformIdentity, id: string, read: unknown) {
    if (typeof read !== 'boolean')
      throw new BadRequestException('Expected boolean read state');
    const visible = this.visible(identity);
    const selected =
      id === 'all' ? visible : visible.filter((r) => r.notification.id === id);
    if (id !== 'all' && !selected.length) throw new NotFoundException();
    this.db.transaction((tx) => {
      for (const r of selected)
        tx.update(inbox)
          .set({ readAt: read ? Date.now() : null })
          .where(
            and(
              eq(inbox.id, r.notification.id),
              eq(inbox.personId, pushPerson(identity)),
            ),
          )
          .run();
    });
    return { ok: true };
  }
  preference(identity: PlatformIdentity) {
    const id = pushPerson(identity);
    return {
      retentionDays:
        this.db
          .select()
          .from(preferences)
          .where(eq(preferences.personId, id))
          .get()?.retentionDays ?? 7,
    };
  }
  setPreference(identity: PlatformIdentity, days: unknown) {
    const id = pushPerson(identity);
    if (
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365
    )
      throw new BadRequestException('Retention must be between 1 and 365 days');
    this.db
      .insert(preferences)
      .values({ personId: id, retentionDays: days })
      .onConflictDoUpdate({
        target: preferences.personId,
        set: { retentionDays: days },
      })
      .run();
    this.cleanup();
    return { retentionDays: days };
  }
  error(
    identity: PlatformIdentity,
    input: { message?: unknown; threadId?: unknown; projectId?: unknown },
  ) {
    const personId = pushPerson(identity);
    if (!input || typeof input !== 'object')
      throw new BadRequestException('Invalid notification');
    if (
      typeof input.message !== 'string' ||
      !input.message.trim() ||
      input.message.length > 1000
    )
      throw new BadRequestException('Invalid notification message');
    let projectId: string | null = null;
    let threadId: string | null = null;
    if (input.threadId !== undefined) {
      if (typeof input.threadId !== 'string') throw new BadRequestException();
      threadId = input.threadId;
      this.identities.requireThread(identity, threadId);
      projectId =
        this.db
          .select()
          .from(projectAgentThreads)
          .where(eq(projectAgentThreads.threadId, threadId))
          .get()?.projectId ?? null;
    }
    if (input.projectId !== undefined) {
      if (typeof input.projectId !== 'string') throw new BadRequestException();
      if (projectId && projectId !== input.projectId)
        throw new BadRequestException();
      projectId = input.projectId;
    }
    if (projectId) this.identities.requireProject(identity, projectId);
    // Coalesce identical UI errors in a five-minute window, scoped to this person and target.
    const eventKey = JSON.stringify([
      'ui-error',
      projectId,
      threadId,
      input.message,
      Math.floor(Date.now() / 300000),
    ]);
    this.db
      .insert(inbox)
      .values({
        id: randomUUID(),
        personId,
        projectId,
        threadId,
        kind: 'error',
        message: input.message,
        eventKey,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    return { ok: true };
  }
}
