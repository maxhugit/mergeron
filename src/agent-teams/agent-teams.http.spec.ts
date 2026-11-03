import { afterEach, beforeEach, expect, it } from 'vitest';
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
import {
  people,
  projects,
  projectParticipants,
  projectAgentThreads,
} from '../database/schema';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamsService } from './agent-teams.service';
import { AgentTeamsController } from './agent-teams.controller';
import { AgentTeamControlsService } from './agent-team-controls.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { ThreadHistoryService } from '../threads/thread-history.service';
import { ThreadsService } from '../threads/threads.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';

let app: NestFastifyApplication, database: TestDatabase, teamId: string;
const headers = (id = 'member') => ({
  authorization: 'Bearer test-teams',
  'x-webui-auth-source': 'authentik',
  'x-webui-auth-subject': id,
});
const base = '/api/projects/p/agent-teams';
beforeEach(async () => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values(
      ['member', 'outsider'].map((id) => ({
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
    .insert(projects)
    .values(
      ['p', 'q'].map((id) => ({
        id,
        name: id,
        workspacePath: '/' + id,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: 1 })
    .run();
  database.db
    .insert(projectAgentThreads)
    .values({
      projectId: 'p',
      threadId: 'coordinator',
      workspacePath: '/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const store = new AgentTeamStore(database.db);
  teamId = store.create('p', 'coordinator', {
    requestId: 'test',
    objective: 'Private project findings',
    assignments: [
      { key: 'read', role: 'Reader', instructions: 'Read project documents' },
    ],
  }).id;
  const module = await Test.createTestingModule({
    controllers: [AgentTeamsController],
    providers: [
      AgentTeamsService,
      AgentTeamControlsService,
      { provide: CodexProcessManager, useValue: { getGeneration: () => 1 } },
      { provide: ThreadHistoryService, useValue: {} },
      { provide: ThreadsService, useValue: {} },
      {
        provide: PendingApprovalsService,
        useValue: { readPending: () => ({ requests: [] }) },
      },
      AgentTeamStore,
      IdentityService,
      { provide: DRIZZLE_DB, useValue: database.db },
      {
        provide: AuthService,
        useValue: {
          authenticateToken: (value: string) =>
            Promise.resolve({ ok: value === 'test-teams' }),
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
it('requires authentication and project membership for summaries and details', async () => {
  expect(
    (await app.inject({ url: base + '?coordinator=coordinator' })).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        url: base + '?coordinator=coordinator',
        headers: headers('outsider'),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: base + '/' + teamId,
        headers: headers('outsider'),
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({
    url: base + '?coordinator=coordinator',
    headers: headers(),
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json<{ launchAvailable: boolean }>().launchAvailable).toBe(
    false,
  );
});
it('rechecks revoked membership without relying on a previously cached identity', async () => {
  expect(
    (await app.inject({ url: base + '/' + teamId, headers: headers() }))
      .statusCode,
  ).toBe(200);
  database.db
    .delete(projectParticipants)
    .where(eq(projectParticipants.personId, 'member'))
    .run();
  const response = await app.inject({
    url: base + '/' + teamId,
    headers: headers(),
  });
  expect(response.statusCode).toBe(403);
  expect(response.body).not.toContain('Private project findings');
});
it('exposes neither a launch route nor an unfiltered list in the foundation', async () => {
  expect((await app.inject({ url: base, headers: headers() })).statusCode).toBe(
    400,
  );
  expect(
    (
      await app.inject({
        url: base + '/' + teamId + '/launch',
        method: 'POST',
        headers: headers(),
      })
    ).statusCode,
  ).toBe(404);
});
it('rejects reader stop and reconciliation at the HTTP authorization boundary', async () => {
  for (const action of ['stop', 'reconcile']) {
    const response = await app.inject({
      url: `${base}/${teamId}/${action}`,
      method: 'POST',
      headers: headers(),
    });
    expect(response.statusCode).toBe(403);
  }
  expect(
    new AgentTeamStore(database.db).read('p', teamId).stopRequestedAt,
  ).toBeNull();
});
