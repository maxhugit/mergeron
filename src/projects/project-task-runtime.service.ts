/** Project task states follow authoritative runtime events, independently of open UI pages. */
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Subscription } from 'rxjs';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema/ServerNotification';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectTasks,
  projectDeliverables,
  projectTaskActivity,
  projectAgentLaunches,
} from '../database/schema';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { randomUUID } from 'node:crypto';

@Injectable()
export class ProjectTaskRuntimeService
  implements OnModuleInit, OnModuleDestroy
{
  private subscription?: Subscription;
  private refreshing = false;
  private stopped = false;
  private pending = false;
  private observation = 0;
  constructor(
    @Inject(DRIZZLE_DB) private db: AppDatabase,
    private manager: CodexProcessManager,
    private metadata: ThreadMetadataService,
  ) {}
  private listener = (event: ServerNotification) => {
    if (this.stopped) return;
    if (
      [
        'thread/status/changed',
        'turn/started',
        'turn/completed',
        'thread/deleted',
      ].includes(event.method)
    )
      this.observation++;
    if (event.method === 'thread/status/changed')
      this.status(event.params.threadId, event.params.status);
    if (event.method === 'turn/started')
      this.status(event.params.threadId, { type: 'active', activeFlags: [] });
    if (event.method === 'turn/completed')
      this.completed(
        event.params.threadId,
        event.params.turn.status === 'failed',
      );
    if (event.method === 'thread/deleted') this.deleted(event.params.threadId);
  };
  onModuleInit() {
    this.manager.addListener('notification', this.listener);
    this.subscription = this.metadata.changes?.subscribe(
      () => void this.reconcile(),
    );
    void this.reconcile();
  }
  onModuleDestroy() {
    this.stopped = true;
    this.subscription?.unsubscribe();
  }
  async reconcile() {
    if (this.stopped) return;
    if (this.refreshing) {
      this.pending = true;
      return;
    }
    this.refreshing = true;
    const observation = this.observation;
    try {
      const snapshot = await this.metadata.read();
      // A cached snapshot must not overwrite a newer authoritative turn event.
      if (
        !this.stopped &&
        observation === this.observation &&
        !snapshot.freshness?.stale
      ) {
        const linked = new Set(
          this.db
            .select({ id: projectTasks.linkedThreadId })
            .from(projectTasks)
            .where(isNotNull(projectTasks.linkedThreadId))
            .all()
            .map((row) => row.id),
        );
        for (const entry of snapshot.entries)
          if (linked.has(entry.thread.id))
            this.status(entry.thread.id, entry.thread.status);
      }
    } catch {
      /* An unavailable snapshot is not evidence of completion or deletion. */
    } finally {
      this.refreshing = false;
      if (this.pending) {
        this.pending = false;
        void this.reconcile();
      }
    }
  }
  private tasks(threadId: string) {
    return this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.linkedThreadId, threadId))
      .all()
      .filter(
        (task) =>
          task.executionMode === 'agent' &&
          task.agentState !== 'validated' &&
          !['done', 'cancelled'].includes(task.subtaskStatus),
      );
  }
  status(threadId: string, status: { type: string; activeFlags?: string[] }) {
    for (const task of this.tasks(threadId)) {
      if (status.type === 'active') {
        const waiting = status.activeFlags?.some((flag) =>
          ['waitingOnApproval', 'waitingOnUserInput'].includes(flag),
        );
        this.write(task, waiting ? 'waiting' : 'running', 'started');
      } else if (
        status.type === 'idle' &&
        ['running', 'waiting'].includes(task.agentState)
      )
        this.write(task, 'review', 'review');
    }
  }
  completed(threadId: string, failed: boolean) {
    for (const task of this.tasks(threadId))
      this.write(
        task,
        failed ? 'error' : 'review',
        failed ? task.subtaskStatus : 'review',
      );
  }
  private write(
    task: typeof projectTasks.$inferSelect,
    agentState: string,
    subtaskStatus: string,
  ) {
    if (task.agentState === agentState && task.subtaskStatus === subtaskStatus)
      return;
    this.db
      .update(projectTasks)
      .set({
        agentState,
        ...(task.parentTaskId ? { subtaskStatus } : {}),
        updatedAt: Math.max(Date.now(), task.updatedAt + 1),
      })
      .where(
        and(
          eq(projectTasks.id, task.id),
          eq(projectTasks.updatedAt, task.updatedAt),
          eq(projectTasks.linkedThreadId, task.linkedThreadId!),
        ),
      )
      .run();
  }
  deleted(threadId: string) {
    this.db.transaction((tx) => {
      tx.delete(projectAgentLaunches)
        .where(eq(projectAgentLaunches.threadId, threadId))
        .run();
      for (const task of tx
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.linkedThreadId, threadId))
        .all()) {
        tx.update(projectTasks)
          .set({
            linkedThreadId: null,
            agentState: task.agentState === 'validated' ? 'validated' : 'error',
            updatedAt: Math.max(Date.now(), task.updatedAt + 1),
          })
          .where(eq(projectTasks.id, task.id))
          .run();
        tx.insert(projectTaskActivity)
          .values({
            id: randomUUID(),
            resourceId: task.resourceId,
            taskId: task.id,
            taskTitle: task.title,
            parentTaskId: task.parentTaskId,
            action: 'updated',
            changes: { linkedThreadId: { before: threadId, after: null } },
            actorName: 'Système',
            createdAt: Date.now(),
          })
          .run();
      }
      for (const item of tx.select().from(projectDeliverables).all()) {
        const conversations = item.conversations.filter(
          (link) => !(link.type === 'agent' && link.id === threadId),
        );
        if (conversations.length !== item.conversations.length)
          tx.update(projectDeliverables)
            .set({
              conversations,
              version: item.version + 1,
              updatedAt: Date.now(),
            })
            .where(eq(projectDeliverables.id, item.id))
            .run();
      }
    });
  }
}
