import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Subject } from 'rxjs';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectAgentThreads,
  projectParticipants,
  inboxNotifications,
} from '../database/schema';
import { IdentityService } from '../auth/identity.service';
import { NotificationsService } from './notifications.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
let db: TestDatabase;
let ids: IdentityService;
let service: NotificationsService;
let manager: EventEmitter;
let requests: Subject<{
  status: string;
  threadId: string;
  method: string;
  instanceId: string;
}>;
beforeEach(() => {
  db = createTestDatabase();
  ids = new IdentityService(db.db);
  manager = new EventEmitter();
  requests = new Subject();
  db.db
    .insert(people)
    .values(
      ['admin', 'member', 'outsider'].map((id) => ({
        id,
        reference: id,
        name: id,
        role:
          id === 'admin' ? ('administrator' as const) : ('standard' as const),
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  db.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Private project',
      workspacePath: '/workspaces/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.db
    .insert(projectAgentThreads)
    .values({
      threadId: 't',
      projectId: 'p',
      workspacePath: '/workspaces/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: 1 })
    .run();
  service = new NotificationsService(
    db.db,
    ids,
    manager as unknown as CodexProcessManager,
    { requests } as unknown as PendingApprovalsService,
  );
  service.onModuleInit();
});
afterEach(() => {
  service.onModuleDestroy();
  db.sqlite.close();
});
const who = (id = 'member') => ids.resolvePerson(id);
it('ignores successful completions and records attention without any push subscription', () => {
  manager.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 't', turn: { id: 'turn1', status: 'completed' } },
  });
  manager.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 't', turn: { id: 'turn1', status: 'completed' } },
  });
  requests.next({
    status: 'pending',
    threadId: 't',
    method: 'item/tool/requestUserInput',
    instanceId: 'q',
  });
  expect(
    service
      .list(who())
      .items.map((n) => n.kind)
      .sort(),
  ).toEqual(['question']);
  expect(service.list(who('outsider')).unread).toBe(0);
});
it('rechecks project rights for lists, counts, individual mutations and mark-all', () => {
  service.recordThread('t', 'approval', 'event');
  const n = service.list(who()).items[0];
  db.db
    .delete(projectParticipants)
    .where(eq(projectParticipants.personId, 'member'))
    .run();
  expect(service.list(who())).toMatchObject({ items: [], unread: 0 });
  expect(() => service.read(who(), n.id, true)).toThrow();
  service.read(who(), 'all', true);
  expect(
    db.db
      .select()
      .from(inboxNotifications)
      .where(eq(inboxNotifications.id, n.id))
      .get()?.readAt,
  ).toBeNull();
});
it('does not allow another person to mark a notification as read', () => {
  service.recordThread('t', 'approval', 'event');
  const n = service.list(who()).items[0];
  expect(() => service.read(who('admin'), n.id, true)).toThrow();
  service.read(who(), n.id, true);
  expect(service.list(who(), 'unread').items).toHaveLength(0);
  expect(service.list(who(), 'read').items).toHaveLength(1);
  service.read(who(), n.id, false);
  expect(service.list(who()).unread).toBe(1);
});
it('keeps retention per person, cleans read and unread records, and never deletes conversations', () => {
  service.recordThread('t', 'approval', 'event');
  db.db
    .update(inboxNotifications)
    .set({ createdAt: Date.now() - 2 * 86400000 })
    .run();
  service.setPreference(who(), 1);
  expect(service.list(who()).items).toHaveLength(0);
  expect(service.list(who('admin')).items).toHaveLength(1);
  expect(service.preference(who('admin')).retentionDays).toBe(7);
  expect(db.db.select().from(projectAgentThreads).all()).toHaveLength(1);
  for (const value of [0, 366, 1.5, '7', null])
    expect(() => service.setPreference(who(), value)).toThrow();
});
it('orders newest first with stable cursor pages and total unread count', () => {
  for (let i = 0; i < 105; i++)
    service.error(who(), { message: 'Error ' + i, projectId: 'p' });
  const first = service.list(who());
  expect(first.items).toHaveLength(100);
  expect(first.unread).toBe(105);
  expect(first.nextCursor).not.toBeNull();
  const second = service.list(who(), 'all', first.nextCursor!);
  expect(second.items).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((n) => n.id)).size).toBe(
    105,
  );
});
it('only stores UI errors for their author and rejects inaccessible contexts', () => {
  service.error(who(), { message: 'Error', projectId: 'p', threadId: 't' });
  service.error(who(), { message: 'Error', projectId: 'p', threadId: 't' });
  expect(service.list(who()).items).toHaveLength(1);
  expect(service.list(who('admin')).items).toHaveLength(0);
  expect(() =>
    service.error(who('outsider'), { message: 'Error', projectId: 'p' }),
  ).toThrow();
  expect(() => service.error(who(), { message: 'x'.repeat(1001) })).toThrow();
  expect(() =>
    service.preference({ ...who(), impersonation: {} as never }),
  ).toThrow();
});
it('records turn failures and does not notify for ephemeral or interrupted turns', () => {
  manager.emit('notification', {
    method: 'thread/started',
    params: { thread: { id: 't', ephemeral: true } },
  });
  manager.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 't', turn: { id: 'a', status: 'completed' } },
  });
  expect(service.list(who()).items).toHaveLength(0);
  manager.emit('notification', {
    method: 'thread/deleted',
    params: { threadId: 't' },
  });
  manager.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 't', turn: { id: 'b', status: 'failed' } },
  });
  expect(service.list(who()).items[0].kind).toBe('error');
});

it('excludes historical completion notifications from lists and unread counts', () => {
  service.recordThread('t', 'completed', 'ignored');
  expect(db.db.select().from(inboxNotifications).all()).toHaveLength(0);
  db.db
    .insert(inboxNotifications)
    .values({
      id: 'legacy-completion',
      personId: 'member',
      projectId: 'p',
      threadId: 't',
      kind: 'completed',
      message: '',
      eventKey: 'legacy',
      createdAt: Date.now(),
    })
    .run();
  service.recordThread('t', 'approval', 'approval');
  expect(service.list(who()).items.map((n) => n.kind)).toEqual(['approval']);
  expect(service.list(who()).unread).toBe(1);
  expect(service.list(who(), 'unread').items).toHaveLength(1);
  expect(service.list(who(), 'read').items).toHaveLength(0);
});
