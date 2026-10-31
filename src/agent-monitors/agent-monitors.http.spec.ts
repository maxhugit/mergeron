import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { PlatformAccessGuard } from '../auth/platform-access.guard';
import { AuthService } from '../auth/auth.service';
import { IdentityService } from '../auth/identity.service';
import { DRIZZLE_DB } from '../database/database.constants';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { people, projects, projectAgentThreads } from '../database/schema';
import { AgentMonitorsController } from './agent-monitors.controller';
import { AgentMonitorsService } from './agent-monitors.service';
import {
  AgentMonitorStore,
  type AgentMonitor,
  type AgentMonitorRun,
} from './agent-monitor-store';
import { AgentMonitorRuntime } from './agent-monitor-runtime.service';

let app: NestFastifyApplication;
let database: TestDatabase;
type MonitorResponse = { monitor: AgentMonitor; runs: AgentMonitorRun[] };
const runtime = { authorize: vi.fn(), verifyIdleForResume: vi.fn() };
const headers = (id = 'admin') => ({
  authorization: 'Bearer test-bearer',
  'x-webui-auth-source': 'authentik',
  'x-webui-auth-subject': id,
});
const path = '/api/projects/p/agent-monitors';
const definition = () => ({
  requestId: 'request',
  threadId: 't',
  name: 'Watch checks',
  instructions: 'Read checks.',
  runAt: Date.now(),
  intervalMs: 60_000,
  expiresAt: Date.now() + 3_600_000,
});
beforeEach(async () => {
  runtime.authorize.mockReset();
  runtime.verifyIdleForResume.mockReset().mockResolvedValue(undefined);
  database = createTestDatabase();
  database.db
    .insert(people)
    .values(
      ['admin', 'standard'].map((id) => ({
        id,
        reference: id,
        name: id,
        identitySubject: id,
        role:
          id === 'admin' ? ('administrator' as const) : ('standard' as const),
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  database.db
    .insert(projects)
    .values(
      ['p', 'q'].map((id) => ({
        id,
        name: id,
        workspacePath: `/${id}`,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  database.db
    .insert(projectAgentThreads)
    .values([
      {
        threadId: 't',
        projectId: 'p',
        workspacePath: '/p',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        threadId: 'other',
        projectId: 'q',
        workspacePath: '/q',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  const module = await Test.createTestingModule({
    controllers: [AgentMonitorsController],
    providers: [
      AgentMonitorsService,
      AgentMonitorStore,
      IdentityService,
      { provide: DRIZZLE_DB, useValue: database.db },
      { provide: AgentMonitorRuntime, useValue: runtime },
      {
        provide: AuthService,
        useValue: {
          authenticateToken: (value: string) =>
            Promise.resolve({ ok: value === 'test-bearer' }),
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

it('requires authentication and a personal administrator for reads and writes', async () => {
  expect((await app.inject({ url: path })).statusCode).toBe(401);
  expect(
    (await app.inject({ url: path, headers: headers('standard') })).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: path,
        headers: { authorization: 'Bearer test-bearer' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: path,
        method: 'POST',
        headers: headers('standard'),
        payload: definition(),
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({ url: path, headers: headers() });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
});

it('validates bounded input, exact thread membership, idempotency and project-scoped lookups', async () => {
  const payload = definition();
  for (const invalid of [
    { personId: 'standard' },
    { maxRuns: 1000 },
    { intervalMs: 1 },
    { threadId: 'other' },
  ])
    expect(
      (
        await app.inject({
          url: path,
          method: 'POST',
          headers: headers(),
          payload: { ...payload, ...invalid },
        })
      ).statusCode,
    ).toBe(400);
  const created = await app.inject({
    url: path,
    method: 'POST',
    headers: headers(),
    payload,
  });
  expect(created.statusCode).toBe(201);
  const { monitor } = created.json<MonitorResponse>();
  expect(monitor).toMatchObject({ personId: 'admin', accessMode: 'readOnly' });
  expect(
    (
      await app.inject({
        url: path,
        method: 'POST',
        headers: headers(),
        payload,
      })
    ).json<MonitorResponse>().monitor.id,
  ).toBe(monitor.id);
  expect(
    (
      await app.inject({
        url: path,
        method: 'POST',
        headers: headers(),
        payload: { ...payload, name: 'Different' },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        url: `/api/projects/q/agent-monitors/${monitor.id}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(404);
  const history = await app.inject({
    url: `${path}/${monitor.id}`,
    headers: headers(),
  });
  expect(history.headers['cache-control']).toBe('no-store');
  expect(history.json<MonitorResponse>().runs).toEqual([]);
});

it('does not resume after the caller is revoked during a native idleness check', async () => {
  const created = await app.inject({
    url: path,
    method: 'POST',
    headers: headers(),
    payload: definition(),
  });
  const id = created.json<MonitorResponse>().monitor.id;
  expect(
    (
      await app.inject({
        url: `${path}/${id}/pause`,
        method: 'POST',
        headers: headers(),
      })
    ).json<MonitorResponse>().monitor.status,
  ).toBe('paused');
  runtime.verifyIdleForResume.mockImplementationOnce(async () => {
    await Promise.resolve();
    database.db
      .update(people)
      .set({ active: false })
      .where(eq(people.id, 'admin'))
      .run();
  });
  expect(
    (
      await app.inject({
        url: `${path}/${id}/resume`,
        method: 'POST',
        headers: headers(),
      })
    ).statusCode,
  ).toBe(403);
  expect(new AgentMonitorStore(database.db).get('p', id).status).toBe('paused');
});
