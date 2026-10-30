import { afterEach, beforeEach, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { PlatformAccessGuard } from '../auth/platform-access.guard';
import { AuthService } from '../auth/auth.service';
import { IdentityService } from '../auth/identity.service';
import { DRIZZLE_DB } from '../database/database.constants';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { people, pushSubscriptions } from '../database/schema';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { PushTransportService } from './push-transport.service';
import { Subject } from 'rxjs';
import { EventEmitter } from 'node:events';
let app: NestFastifyApplication;
let database: TestDatabase;
beforeEach(async () => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values(
      ['one', 'two'].map((id) => ({
        id,
        reference: id,
        name: id,
        identitySubject: id,
        role: 'standard' as const,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  database.db
    .insert(pushSubscriptions)
    .values({
      id: 'device',
      personId: 'one',
      endpoint: 'https://fcm.googleapis.com/secret',
      p256dh: 'key',
      auth: 'secret',
      label: 'Phone',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const module = await Test.createTestingModule({
    controllers: [PushController],
    providers: [
      PushService,
      IdentityService,
      ThreadDeletionRegistryService,
      { provide: DRIZZLE_DB, useValue: database.db },
      { provide: CodexProcessManager, useValue: new EventEmitter() },
      {
        provide: PendingApprovalsService,
        useValue: { requests: new Subject() },
      },
      {
        provide: ThreadMetadataService,
        useValue: { getHeldThread: () => null },
      },
      {
        provide: PushTransportService,
        useValue: {
          publicKey: () => 'key',
          send: () => Promise.resolve(undefined),
        },
      },
      {
        provide: AuthService,
        useValue: {
          authenticateToken: (value: string) =>
            Promise.resolve({
              ok: value === 'test-bearer',
            }),
        },
      },
      { provide: APP_GUARD, useClass: ApiKeyGuard },
      { provide: APP_GUARD, useClass: PlatformAccessGuard },
    ],
  }).compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('api');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterEach(async () => {
  await app.close();
  database.sqlite.close();
});
const headers = (id = 'one') => ({
  authorization: 'Bearer test-bearer',
  'x-webui-auth-source': 'authentik',
  'x-webui-auth-subject': id,
});
it('requires authentication and a personal identity, and returns a no-store scoped device listing', async () => {
  expect((await app.inject({ url: '/api/push' })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: '/api/push',
        headers: { authorization: 'Bearer test-bearer' },
      })
    ).statusCode,
  ).toBe(403);
  const own = await app.inject({ url: '/api/push', headers: headers() });
  expect(own.statusCode).toBe(200);
  expect(own.headers['cache-control']).toBe('no-store');
  expect(own.json<{ devices: unknown[] }>().devices).toHaveLength(1);
  expect(own.body).not.toContain('secret');
  const other = await app.inject({ url: '/api/push', headers: headers('two') });
  expect(other.json<{ devices: unknown[] }>().devices).toEqual([]);
  for (const method of ['PATCH', 'DELETE', 'POST'] as const) {
    const url = `/api/push/subscriptions/device${method === 'POST' ? '/test' : ''}`;
    const response = await app.inject({
      url,
      method,
      headers: headers('two'),
      ...(method === 'PATCH' ? { payload: { completed: false } } : {}),
    });
    expect(response.statusCode).toBe(404);
  }
});
