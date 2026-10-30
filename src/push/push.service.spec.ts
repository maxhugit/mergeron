import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Subject } from 'rxjs';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  conversationOwners,
  people,
  pendingServerRequests,
  projectAgentThreads,
  projectParticipants,
  projects,
  pushDeliveries,
  pushSubscriptions,
} from '../database/schema';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { PushTransportService } from './push-transport.service';
import { PushService } from './push.service';
import { validatePushEndpoint, validateSubscription } from './push-validation';

let database: TestDatabase;
let identities: IdentityService;
let manager: EventEmitter;
let requests: Subject<{
  status: string;
  method: string;
  threadId: string;
  instanceId: string;
}>;
let send: ReturnType<typeof vi.fn<PushTransportService['send']>>;
let service: PushService;
let deletion: ThreadDeletionRegistryService;
let admin: PlatformIdentity;
let member: PlatformIdentity;
const input = (suffix = 'one') => {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    label: 'Phone',
    language: 'fr',
    subscription: {
      endpoint: `https://fcm.googleapis.com/push/${suffix}`,
      keys: {
        auth: randomBytes(16).toString('base64url'),
        p256dh: key.getPublicKey().toString('base64url'),
      },
    },
  };
};
beforeEach(() => {
  database = createTestDatabase();
  database.db
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
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Private project',
      workspacePath: '/workspaces/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values({
      threadId: 't1',
      projectId: 'p',
      workspacePath: '/workspaces/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: 1 })
    .run();
  identities = new IdentityService(database.db);
  admin = identities.resolvePerson('admin');
  member = identities.resolvePerson('member');
  manager = new EventEmitter();
  requests = new Subject();
  send = vi.fn().mockResolvedValue(undefined);
  deletion = new ThreadDeletionRegistryService();
  service = new PushService(
    database.db,
    identities,
    manager as unknown as CodexProcessManager,
    { requests } as unknown as PendingApprovalsService,
    { getHeldThread: () => null } as unknown as ThreadMetadataService,
    deletion,
    { publicKey: () => 'public', send } as unknown as PushTransportService,
  );
  service.onModuleInit();
});
afterEach(() => {
  service.onModuleDestroy();
  database.sqlite.close();
  vi.useRealTimers();
});
const rows = () => database.db.select().from(pushDeliveries).all();
function complete(turnId = 'turn1', status = 'completed', threadId = 't1') {
  manager.emit('notification', {
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status } },
  });
}
function attention(
  instanceId: string,
  method = 'item/commandExecution/requestApproval',
) {
  database.db
    .insert(pendingServerRequests)
    .values({
      instanceId,
      generation: 1,
      requestId: instanceId,
      threadId: 't1',
      method,
      paramsJson: '{"privateCommand":"not-for-push"}',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  requests.next({ instanceId, threadId: 't1', method, status: 'pending' });
}
it('persists one scoped device, returns no capabilities, and cannot steal or manage another person’s device', () => {
  const value = input();
  const device = service.subscribe(member, value);
  expect(service.subscribe(member, value).id).toBe(device.id);
  expect(service.status(member).devices).toHaveLength(1);
  const serialized = JSON.stringify(service.status(member));
  for (const secret of [
    value.subscription.endpoint,
    value.subscription.keys.auth,
    value.subscription.keys.p256dh,
  ])
    expect(serialized).not.toContain(secret);
  expect(() => service.subscribe(admin, value)).toThrow(
    'pushDeviceAlreadyLinked',
  );
  for (const run of [
    () => service.remove(admin, device.id),
    () => service.preferences(admin, device.id, { completed: false }),
    () => service.test(admin, device.id),
  ])
    expect(run).toThrow('pushDeviceNotFound');
  expect(() =>
    service.preferences(member, device.id, { personId: 'admin' }),
  ).toThrow('pushInvalidPreferences');
  expect(() =>
    service.preferences(member, device.id, { completed: 'yes' }),
  ).toThrow();
});
it('refuses service, unlinked, inactive, and impersonated identities for every endpoint', () => {
  const device = service.subscribe(admin, input());
  for (const identity of [
    { ...admin, active: false },
    { ...admin, kind: 'service' as const },
    { ...admin, kind: 'unlinked' as const },
    { ...admin, role: null },
    { ...admin, impersonation: { sessionId: 'i' } } as PlatformIdentity,
  ]) {
    for (const run of [
      () => service.status(identity),
      () => service.subscribe(identity, input('x')),
      () => service.remove(identity, device.id),
      () => service.preferences(identity, device.id, {}),
      () => service.test(identity, device.id),
    ])
      expect(run).toThrow('pushPersonalAccountRequired');
  }
});
it('filters access, successful final turns, duplicate events, and never includes private text', async () => {
  service.subscribe(admin, input('admin'));
  service.subscribe(member, input('member'));
  service.subscribe(identities.resolvePerson('outsider'), input('outsider'));
  complete('failed', 'failed');
  complete('interrupted', 'interrupted');
  manager.emit('notification', {
    method: 'item/completed',
    params: { threadId: 't1', item: { text: 'private answer' } },
  });
  expect(rows()).toHaveLength(0);
  complete();
  complete();
  expect(rows()).toHaveLength(2);
  await service.drain();
  await service.drain();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][1]).toMatchObject({
    version: 1,
    kind: 'completed',
    threadId: 't1',
    language: 'fr',
  });
  expect(Object.keys(send.mock.calls[0][1]).sort()).toEqual([
    'id',
    'kind',
    'language',
    'threadId',
    'version',
  ]);
  expect(rows().every((row) => row.status === 'sent')).toBe(true);
  service.subscribe(admin, input('later'));
  complete();
  expect(rows()).toHaveLength(2);
});
it('drops queued notifications after rights, activity, preferences, or conversation existence change', async () => {
  const device = service.subscribe(member, input());
  complete();
  database.db.delete(projectParticipants).run();
  await service.drain();
  expect(send).not.toHaveBeenCalled();
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: 1 })
    .run();
  complete('turn2');
  service.preferences(member, device.id, { completed: false });
  await service.drain();
  expect(send).not.toHaveBeenCalled();
  service.preferences(member, device.id, { completed: true });
  complete('turn3');
  database.db
    .update(people)
    .set({ active: false })
    .where(eq(people.id, 'member'))
    .run();
  await service.drain();
  expect(send).not.toHaveBeenCalled();
  database.db
    .update(people)
    .set({ active: true })
    .where(eq(people.id, 'member'))
    .run();
  complete('turn4');
  deletion.begin(['t1']);
  await service.drain();
  expect(send).not.toHaveBeenCalled();
  deletion.end(['t1']);
  complete('turn5');
  manager.emit('notification', {
    method: 'thread/deleted',
    params: { threadId: 't1' },
  });
  await service.drain();
  expect(send).not.toHaveBeenCalled();
  expect(rows().every((row) => row.status === 'dropped')).toBe(true);
});
it('only queues real pending attention, only for responders, and ignores already resolved requests', async () => {
  service.subscribe(admin, input('a'));
  service.subscribe(member, input('b'));
  attention('approval');
  attention('question', 'item/tool/requestUserInput');
  expect(rows().map((row) => row.kind)).toEqual(['approvals', 'questions']);
  requests.next({
    instanceId: 'approval',
    threadId: 't1',
    method: 'item/commandExecution/requestApproval',
    status: 'pending',
  });
  expect(rows()).toHaveLength(2);
  database.db
    .update(pendingServerRequests)
    .set({ status: 'resolved' })
    .where(eq(pendingServerRequests.instanceId, 'approval'))
    .run();
  await service.drain();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toMatchObject({ kind: 'questions' });
});
it('ignores unknown/internal threads and stops observing after shutdown', () => {
  service.subscribe(admin, input());
  complete('x', 'completed', 'unknown');
  database.db
    .insert(conversationOwners)
    .values({ kind: 'agent', conversationId: 'internal', personId: 'admin' })
    .run();
  manager.emit('notification', {
    method: 'thread/started',
    params: { thread: { id: 'internal', ephemeral: true } },
  });
  complete('y', 'completed', 'internal');
  expect(rows()).toHaveLength(0);
  service.onModuleDestroy();
  complete();
  expect(rows()).toHaveLength(0);
});
it('retains and retries transient failures with a stable tag, bounded attempts and expiry', async () => {
  const device = service.subscribe(admin, input());
  complete();
  send.mockRejectedValue(
    Object.assign(new Error('secret provider response'), { statusCode: 503 }),
  );
  for (let n = 0; n < 4; n++) {
    database.db.update(pushDeliveries).set({ nextAttemptAt: 0 }).run();
    await service.drain();
  }
  expect(send).toHaveBeenCalledTimes(4);
  expect(new Set(send.mock.calls.map((call) => call[3])).size).toBe(1);
  expect(rows()[0]).toMatchObject({ attempts: 4, status: 'dropped' });
  complete('expiry');
  database.db
    .update(pushDeliveries)
    .set({ expiresAt: Date.now() - 1 })
    .run();
  await service.drain();
  expect(send).toHaveBeenCalledTimes(4);
  service.remove(admin, device.id);
  expect(rows()).toHaveLength(0);
});
it('recovers a stale in-flight lease from durable storage without recreating events', async () => {
  service.subscribe(admin, input());
  complete();
  const id = rows()[0].id;
  database.db
    .update(pushDeliveries)
    .set({ status: 'sending', attempts: 1, leaseAt: Date.now() - 61_000 })
    .run();
  service.onModuleDestroy();
  service = new PushService(
    database.db,
    identities,
    manager as unknown as CodexProcessManager,
    { requests } as unknown as PendingApprovalsService,
    { getHeldThread: () => null } as unknown as ThreadMetadataService,
    deletion,
    { publicKey: () => 'public', send } as unknown as PushTransportService,
  );
  service.onModuleInit();
  complete();
  await service.drain();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ id, attempts: 2, status: 'sent' });
  expect(send).toHaveBeenCalledOnce();
});
it.each([404, 410])(
  'removes expired endpoint capabilities and their outbox on HTTP %s',
  async (statusCode) => {
    service.subscribe(admin, input());
    complete();
    send.mockRejectedValue({ statusCode });
    await service.drain();
    expect(database.db.select().from(pushSubscriptions).all()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  },
);
it('supports personal test state without enabling other devices and rate-limits tests', async () => {
  const device = service.subscribe(member, input());
  service.test(member, device.id);
  expect(() => service.test(member, device.id)).toThrow('pushTestRateLimited');
  expect(service.status(member).devices[0].lastTestStatus).toBe('pending');
  await service.drain();
  expect(service.status(member).devices[0].lastTestStatus).toBe('sent');
  expect(send.mock.calls[0][1]).toMatchObject({ kind: 'test', threadId: null });
});
it.each([
  'http://fcm.googleapis.com/a',
  'https://fcm.googleapis.com.evil.test/a',
  'https://127.0.0.1/a',
  'https://push.apple.com@evil.test/a',
  'https://push.apple.com:8443/a',
  'https://push.apple.com/a#x',
  'https://example.com/a',
  'https://[::1]/a',
])('rejects an unsafe endpoint: %s', (endpoint) => {
  expect(() => validatePushEndpoint(endpoint)).toThrow(
    'pushInvalidSubscription',
  );
});
it('validates modern browser endpoint/key formats without accepting invalid curve points or malformed base64', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/a',
    'https://web.push.apple.com/a',
    'https://updates.push.services.mozilla.com/a',
    'https://wns2.notify.windows.com/a',
  ])
    expect(validatePushEndpoint(endpoint)).toBe(endpoint);
  const value = input();
  expect(validateSubscription(value)).toMatchObject({ label: 'Phone' });
  value.subscription.keys.p256dh = Buffer.alloc(65, 1).toString('base64url');
  expect(() => validateSubscription(value)).toThrow();
  const bad = input();
  bad.subscription.keys.auth += '=';
  expect(() => validateSubscription(bad)).toThrow();
});
