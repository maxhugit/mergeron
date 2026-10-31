import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessContextInterceptor } from './access-context.interceptor';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { DRIZZLE_DB } from '../database/database.constants';
import {
  people,
  projectParticipants,
  projectResources,
  projects,
} from '../database/schema';
import { SettingsController } from '../settings/settings.controller';
import { ImageUpdateService } from '../settings/image-update.service';
import { ServerReleaseService } from '../settings/server-release.service';
import { ManagerStatusService } from '../settings/manager-status.service';
import { SettingsService } from '../settings/settings.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './api-key.guard';
import { PlatformAccessGuard } from './platform-access.guard';
import { IdentityService } from './identity.service';
import { AuthConfigService } from './auth-config.service';
import { OidcAuthService } from './oidc-auth.service';
import { LocalAuthService } from './local-auth.service';
import { ProjectsController } from '../projects/projects.controller';
import { ProjectsService } from '../projects/projects.service';
import { ProjectKnowledgeService } from '../project-knowledge/project-knowledge.service';
import { KnowledgeProposalsService } from '../project-knowledge/knowledge-proposals.service';
import { ProjectKnowledgeController } from '../project-knowledge/project-knowledge.controller';
import { DeliverablesController } from '../deliverables/deliverables.controller';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { ThreadsService } from '../threads/threads.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';

let app: NestFastifyApplication;
let database: TestDatabase;
let workspaceRoot: string;
const proxyHeaders = (email = 'standard@example.com') => ({
  authorization: 'Bearer isolated-http-test',
  'x-webui-auth-source': 'authentik',
  'x-webui-auth-subject': email,
  'x-webui-auth-email': email,
});
beforeEach(async () => {
  vi.stubEnv('WEBUI_REQUIRE_IDENTITY', 'true');
  database = createTestDatabase();
  workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'platform-access-'));
  const memberWorkspace = path.join(workspaceRoot, 'member');
  const outsideWorkspace = path.join(workspaceRoot, 'outside');
  await Promise.all(
    [
      [memberWorkspace, 'member-project'],
      [outsideWorkspace, 'outside-project'],
    ].map(async ([workspace, projectId]) => {
      await fsp.mkdir(path.join(workspace, '.mergeron', 'knowledge'), {
        recursive: true,
      });
      await fsp.mkdir(path.join(workspace, '.mergeron', 'history'), {
        recursive: true,
      });
      await fsp.writeFile(
        path.join(workspace, '.mergeron', 'project.json'),
        JSON.stringify({ projectId, layoutVersion: 2 }),
      );
    }),
  );
  database.db
    .insert(people)
    .values(
      ['standard', 'administrator'].map((role) => ({
        id: role,
        reference: role,
        name: `Test ${role}`,
        firstName: 'Test',
        lastName: role,
        email: `${role}@example.com`,
        phone: '0600000000',
        role: role as 'standard' | 'administrator',
        identitySubject:
          role === 'administrator' ? `${role}@example.com` : null,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  database.db
    .insert(projects)
    .values([
      {
        id: 'member-project',
        name: 'Member project',
        workspacePath: memberWorkspace,
        workspaceLayoutVersion: 2,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'outside-project',
        name: 'Outside project',
        workspacePath: outsideWorkspace,
        workspaceLayoutVersion: 2,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  database.db
    .insert(projectParticipants)
    .values({
      projectId: 'member-project',
      personId: 'standard',
      createdAt: 1,
    })
    .run();
  const projectsService = new ProjectsService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    database.db,
  );
  const module = await Test.createTestingModule({
    imports: [JwtModule.register({})],
    controllers: [
      AuthController,
      SettingsController,
      ProjectsController,
      ProjectKnowledgeController,
      DeliverablesController,
    ],
    providers: [
      AuthService,
      AuthConfigService,
      LocalAuthService,
      OidcAuthService,
      IdentityService,
      {
        provide: ImageUpdateService,
        useValue: {
          status: () => ({ installed: { version: '0.1.0' } }),
          installedChanges: () => ({
            revision: 'a'.repeat(40),
            items: ['Installed change'],
          }),
        },
      },
      ProjectKnowledgeService,
      KnowledgeProposalsService,
      {
        provide: DeliverablesService,
        useValue: {
          submit: () => ({ ok: true }),
          versionFiles: () => [{ sourcePath: '/home/codex/private.txt' }],
        },
      },
      { provide: ThreadsService, useValue: {} },
      { provide: ThreadMetadataService, useValue: {} },
      { provide: GitMutationGateService, useValue: {} },
      { provide: DRIZZLE_DB, useValue: database.db },
      { provide: ProjectsService, useValue: projectsService },
      {
        provide: ConfigService,
        useValue: new ConfigService({ WEBUI_API_KEY: 'isolated-http-test' }),
      },
      {
        provide: SettingsService,
        useValue: {
          getSetting: (key: string) => ({
            key,
            value: 'test common instructions',
          }),
          updateSetting: (key: string, value: unknown) => ({ key, value }),
          listSettings: () => [
            { key: 'private-test-setting', value: 'not-for-standard-users' },
          ],
        },
      },
      {
        provide: ServerReleaseService,
        useValue: { status: () => ({ installed: { version: '0.1.0' } }) },
      },
      {
        provide: ManagerStatusService,
        useValue: {
          status: () => ({ available: true, mode: 'observe' }),
          adopt: () => ({ adoption: { state: 'adopted' } }),
          installationPlan: () => ({ applicable: true, actions: [] }),
          install: () => ({ changed: false, applied: [] }),
        },
      },
      { provide: APP_GUARD, useClass: ApiKeyGuard },
      { provide: APP_GUARD, useClass: PlatformAccessGuard },
      { provide: APP_INTERCEPTOR, useClass: AccessContextInterceptor },
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

it('blocks private deliverable sources, private snapshot downloads and agent execution for standard users', async () => {
  const base = '/api/projects/member-project/resources/r/deliverables/d';
  for (const url of [`${base}/agent`, `${base}/versions`]) {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: proxyHeaders(),
      payload: { version: 1, paths: ['/home/codex/private.txt'] },
    });
    expect(response.statusCode).toBe(403);
  }
  const download = await app.inject({
    method: 'GET',
    url: `${base}/versions/v/files/0`,
    headers: proxyHeaders(),
  });
  expect(download.statusCode).toBe(403);
});
afterEach(async () => {
  await app.close();
  database.sqlite.close();
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('returns an HTTP redirect when starting the OIDC flow', async () => {
  vi.spyOn(app.get(OidcAuthService), 'start').mockResolvedValue({
    authorizationUrl: 'https://sso.example.test/authorize',
    cookie: 'codex_webui_oidc_state=test-state; Path=/api/auth/oidc',
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/oidc/start?returnTo=%2F',
  });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe('https://sso.example.test/authorize');
  expect(response.headers['set-cookie']).toContain(
    'codex_webui_oidc_state=test-state',
  );
});

it('tests the real target permissions and records the administrator behind real modifications', async () => {
  const admin = {
    ...proxyHeaders('administrator@example.com'),
    host: 'app.test',
    origin: 'http://app.test',
  };
  const started = await app.inject({
    method: 'POST',
    url: '/api/auth/impersonation',
    headers: admin,
    payload: { personId: 'standard' },
  });
  expect(started.statusCode).toBe(201);
  const value = started.headers['set-cookie'];
  const cookie = (Array.isArray(value) ? value[0] : value!).split(';')[0];
  expect(value).toContain('HttpOnly');
  const headers = { ...admin, cookie };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  expect(me.json()).toMatchObject({
    personId: 'standard',
    role: 'standard',
    impersonation: { administratorId: 'administrator' },
  });
  expect(
    (await app.inject({ method: 'GET', url: '/api/settings', headers }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/projects/outside-project/participants',
        headers,
      })
    ).statusCode,
  ).toBe(403);
  const edit = await app.inject({
    method: 'PATCH',
    url: '/api/auth/preferences',
    headers,
    payload: { theme: 'nord' },
  });
  expect(edit.statusCode).toBe(200);
  expect(
    database.sqlite
      .prepare('SELECT theme FROM people WHERE id=?')
      .get('standard'),
  ).toMatchObject({ theme: 'nord' });
  expect(
    database.sqlite
      .prepare('SELECT theme FROM people WHERE id=?')
      .get('administrator'),
  ).not.toMatchObject({ theme: 'nord' });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/impersonation',
        headers,
        payload: { personId: 'administrator' },
      })
    ).statusCode,
  ).toBe(403);
  const stopped = await app.inject({
    method: 'DELETE',
    url: '/api/auth/impersonation',
    headers,
  });
  expect(stopped.statusCode).toBe(200);
  expect(stopped.headers['set-cookie']).toContain('Max-Age=0');
  expect(
    (
      await app.inject({ method: 'GET', url: '/api/auth/me', headers: admin })
    ).json<{ personId: string }>().personId,
  ).toBe('administrator');
  // An old socket/cookie cannot turn back into an administrator after revocation.
  expect(
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers })).json<{
      active: boolean;
    }>().active,
  ).toBe(false);
  const audit = await app.inject({
    method: 'GET',
    url: '/api/auth/impersonation-audit',
    headers: admin,
  });
  expect(audit.statusCode).toBe(200);
  expect(audit.json<{ events: unknown[] }>().events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        administratorId: 'administrator',
        personId: 'standard',
        action: 'httpCompleted',
        route: '/api/auth/preferences',
      }),
    ]),
  );
});

it('refuses non-admin impersonation and cross-origin switches', async () => {
  const basic = {
    ...proxyHeaders(),
    host: 'app.test',
    origin: 'http://app.test',
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/impersonation',
        headers: basic,
        payload: { personId: 'administrator' },
      })
    ).statusCode,
  ).toBe(403);
  const admin = {
    ...proxyHeaders('administrator@example.com'),
    host: 'app.test',
    origin: 'https://evil.test',
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/impersonation',
        headers: admin,
        payload: { personId: 'standard' },
      })
    ).statusCode,
  ).toBe(401);
});

it('returns 403 on real settings routes for standard users and 200 for administrators', async () => {
  const server = app.getHttpAdapter().getInstance();
  const standard = await server.inject({
    method: 'GET',
    url: '/api/settings',
    headers: proxyHeaders(),
  });
  expect(standard.statusCode).toBe(403);
  expect(standard.body).not.toContain('not-for-standard-users');
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/settings',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/settings/manager/adopt',
        headers: proxyHeaders(),
        payload: {
          confirmation: 'ADOPT_EXISTING_INSTALLATION',
          expectedFingerprint: 'fingerprint',
        },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/settings/manager/adopt',
        headers: proxyHeaders('administrator@example.com'),
        payload: {
          confirmation: 'ADOPT_EXISTING_INSTALLATION',
          expectedFingerprint: 'fingerprint',
        },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/settings/release/status',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/settings/release/status',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
  for (const [email, expected] of [
    ['standard@example.com', 403],
    ['administrator@example.com', 200],
  ] as const) {
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/settings/release/installed-changes',
          headers: proxyHeaders(email),
        })
      ).statusCode,
    ).toBe(expected);
  }
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/settings/manager/status',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/settings/manager/status',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/settings/manager/install/plan',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/settings/manager/install/plan',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/settings/manager/install',
        headers: proxyHeaders(),
        payload: { confirmation: 'INSTALL', expectedFingerprint: 'hash' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/settings/manager/install',
        headers: proxyHeaders('administrator@example.com'),
        payload: { confirmation: 'INSTALL', expectedFingerprint: 'hash' },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/auth/configuration',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/auth/configuration',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/auth/sessions/administrator/revoke',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/auth/sessions/standard/revoke',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
});

it('restricts common instruction reads and writes to administrators', async () => {
  for (const method of ['GET', 'PATCH'] as const) {
    for (const role of ['standard', 'administrator']) {
      const response = await app.inject({
        method,
        url: '/api/settings/general.agentInstructions',
        headers: proxyHeaders(`${role}@example.com`),
        ...(method === 'PATCH'
          ? { payload: { value: 'New common text' } }
          : {}),
      });
      expect(response.statusCode).toBe(role === 'administrator' ? 200 : 403);
    }
  }
});

it('persists appearance preferences on the connected person profile', async () => {
  const server = app.getHttpAdapter().getInstance();
  const update = await server.inject({
    method: 'PATCH',
    url: '/api/auth/preferences',
    headers: proxyHeaders(),
    payload: { theme: 'nord', language: 'en' },
  });
  expect(update.statusCode).toBe(200);
  expect(update.json()).toEqual({ theme: 'nord', language: 'en' });

  const me = await server.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: proxyHeaders(),
  });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toMatchObject({ theme: 'nord', language: 'en' });

  const futureLocale = await server.inject({
    method: 'PATCH',
    url: '/api/auth/preferences',
    headers: proxyHeaders(),
    payload: { language: 'es' },
  });
  expect(futureLocale.statusCode).toBe(200);
  expect(futureLocale.json()).toMatchObject({ language: 'es' });

  const invalid = await server.inject({
    method: 'PATCH',
    url: '/api/auth/preferences',
    headers: proxyHeaders(),
    payload: { theme: 'unknown' },
  });
  expect(invalid.statusCode).toBe(400);
  const invalidLocale = await server.inject({
    method: 'PATCH',
    url: '/api/auth/preferences',
    headers: proxyHeaders(),
    payload: { language: '../fr' },
  });
  expect(invalidLocale.statusCode).toBe(400);
});

it('keeps navigation on the connected profile across requests, independently of other people', async () => {
  const save = (
    payload: Record<string, unknown>,
    email = 'standard@example.com',
  ) =>
    app.inject({
      method: 'PATCH',
      url: '/api/auth/preferences',
      headers: proxyHeaders(email),
      payload,
    });
  const me = (email = 'standard@example.com') =>
    app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: proxyHeaders(email),
    });
  expect(
    (await me()).json<{ fastNavigationProjectId: string | null }>()
      .fastNavigationProjectId,
  ).toBeNull();
  expect(
    (
      await save({
        fastNavigationProjectId: 'member-project',
        personId: 'administrator',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await me()).json<{ fastNavigationProjectId: string | null }>()
      .fastNavigationProjectId,
  ).toBe('member-project');
  expect(
    (await me('administrator@example.com')).json<{
      fastNavigationProjectId: string | null;
    }>().fastNavigationProjectId,
  ).toBeNull();
  await save({ theme: 'nord' });
  expect(
    (await me()).json<{ fastNavigationProjectId: string | null }>()
      .fastNavigationProjectId,
  ).toBe('member-project');
  const fresh = new IdentityService(database.db);
  expect(fresh.navigationProject(fresh.resolvePerson('standard'))).toBe(
    'member-project',
  );
  expect((await save({ fastNavigationProjectId: null })).statusCode).toBe(200);
  expect(
    (await me()).json<{ fastNavigationProjectId: string | null }>()
      .fastNavigationProjectId,
  ).toBeNull();
});

it('validates navigation without granting project access', async () => {
  const save = (projectId: unknown, email = 'standard@example.com') =>
    app.inject({
      method: 'PATCH',
      url: '/api/auth/preferences',
      headers: proxyHeaders(email),
      payload: { fastNavigationProjectId: projectId },
    });
  for (const invalid of ['', 12, {}, 'a'.repeat(129)])
    expect((await save(invalid)).statusCode).toBe(400);
  expect((await save('outside-project')).statusCode).toBe(403);
  expect((await save('missing', 'administrator@example.com')).statusCode).toBe(
    400,
  );
  await save('member-project');
  database.sqlite
    .prepare('DELETE FROM project_participants WHERE person_id=?')
    .run('standard');
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: proxyHeaders(),
      })
    ).json<{ fastNavigationProjectId: string | null }>()
      .fastNavigationProjectId,
  ).toBeNull();
  expect((await save('member-project')).statusCode).toBe(403);
});

it('clears deleted navigation projects through the real migration foreign key', async () => {
  await app.inject({
    method: 'PATCH',
    url: '/api/auth/preferences',
    headers: proxyHeaders('administrator@example.com'),
    payload: { fastNavigationProjectId: 'outside-project' },
  });
  database.sqlite
    .prepare('DELETE FROM projects WHERE id=?')
    .run('outside-project');
  expect(
    database.sqlite
      .prepare(
        'SELECT fast_navigation_project_id FROM person_navigation_preferences WHERE person_id=?',
      )
      .get('administrator'),
  ).toMatchObject({ fast_navigation_project_id: null });
});

it('persists sidebar order only for items belonging to the same project', async () => {
  database.db
    .insert(projectResources)
    .values([
      {
        id: 'member-resource',
        projectId: 'member-project',
        type: 'task_board',
        name: 'Member board',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'outside-resource',
        projectId: 'outside-project',
        type: 'task_board',
        name: 'Outside board',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  const server = app.getHttpAdapter().getInstance();
  const headers = proxyHeaders('administrator@example.com');
  const accepted = await server.inject({
    method: 'PATCH',
    url: '/api/projects/member-project/sidebar-order',
    headers,
    payload: { order: ['resource:member-resource'] },
  });
  expect(accepted.statusCode).toBe(200);
  expect(
    accepted.json<{ project: { sidebarOrder: string[] } }>().project
      .sidebarOrder,
  ).toEqual(['resource:member-resource']);

  const rejected = await server.inject({
    method: 'PATCH',
    url: '/api/projects/member-project/sidebar-order',
    headers,
    payload: { order: ['resource:outside-resource'] },
  });
  expect(rejected.statusCode).toBe(400);

  const forgedMove = await server.inject({
    method: 'PATCH',
    url: '/api/projects/member-project/resources/member-resource',
    headers,
    payload: { projectId: 'outside-project' },
  });
  expect(forgedMove.statusCode).toBe(409);
});

it('lets members read knowledge but reserves editing to administrators', async () => {
  const server = app.getHttpAdapter().getInstance();
  for (const method of ['GET', 'PUT'] as const) {
    const response = await server.inject({
      method,
      url: '/api/projects/member-project/knowledge',
      headers: proxyHeaders(),
      ...(method === 'PUT'
        ? { payload: { files: {}, revision: 'forged' } }
        : {}),
    });
    expect(response.statusCode).toBe(method === 'GET' ? 200 : 403);
  }
  const read = await server.inject({
    method: 'GET',
    url: '/api/projects/member-project/knowledge',
    headers: proxyHeaders('administrator@example.com'),
  });
  expect(read.statusCode).toBe(200);
  const snapshot = read.json<{
    files: Record<string, unknown>;
    revision: unknown;
  }>();
  for (const name of ['AGENTS.md', 'CONNAISSANCES.md', 'DECISIONS.md'])
    expect(typeof snapshot.files[name]).toBe('string');
  expect(typeof snapshot.revision).toBe('string');
  const invalid = await server.inject({
    method: 'PUT',
    url: '/api/projects/member-project/knowledge',
    headers: proxyHeaders('administrator@example.com'),
    payload: { files: {}, revision: 'forged' },
  });
  expect(invalid.statusCode).toBe(400);
});

it('reserves proposal listing and review to administrators, including direct forged requests', async () => {
  const server = app.getHttpAdapter().getInstance();
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/projects/member-project/knowledge/proposals',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'PATCH',
        url: '/api/projects/member-project/knowledge/proposals/fake',
        headers: proxyHeaders(),
        payload: { action: 'accept', version: 1, role: 'administrator' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/projects/member-project/knowledge/proposals',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'PATCH',
        url: '/api/projects/member-project/knowledge/proposals/fake',
        headers: proxyHeaders('administrator@example.com'),
        payload: { action: 'accept', version: 1 },
      })
    ).statusCode,
  ).toBe(404);
});

it('does not trust a browser marker or a forged role without backend bearer authentication', async () => {
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'GET',
      url: '/api/settings',
      headers: {
        ...proxyHeaders('administrator@example.com'),
        authorization: 'Bearer authentik-proxy',
        'x-webui-role': 'administrator',
      },
    });
  expect(response.statusCode).toBe(401);
});

it('redacts personal contact data from standard user lists and blocks role escalation through people updates', async () => {
  const server = app.getHttpAdapter().getInstance();
  const response = await server.inject({
    method: 'GET',
    url: '/api/projects/people',
    headers: proxyHeaders(),
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain('0600000000');
  expect(response.body).not.toContain('identitySubject');
  expect(response.body).not.toContain('email');
  expect(
    (
      await server.inject({
        method: 'PATCH',
        url: '/api/projects/people/standard',
        headers: proxyHeaders(),
        payload: { role: 'administrator' },
      })
    ).statusCode,
  ).toBe(403);
});

it('creates a person with required contacts and a computed full name through the administrator API', async () => {
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: '/api/projects/people',
      headers: proxyHeaders('administrator@example.com'),
      payload: {
        reference: 'NEW',
        firstName: 'Alice',
        lastName: 'Test',
        name: 'untrusted name',
        email: 'Alice@example.com',
        phone: '0600000002',
        role: 'standard',
      },
    });
  expect(response.statusCode).toBe(201);
  expect(response.json<{ person: unknown }>().person).toMatchObject({
    name: 'Alice Test',
    email: 'alice@example.com',
    role: 'standard',
  });
});

it('lets active project members read participants but reserves membership changes for administrators', async () => {
  const server = app.getHttpAdapter().getInstance();
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/projects/member-project/participants',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/projects/outside-project/participants',
        headers: proxyHeaders(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/projects/member-project/participants',
        headers: proxyHeaders(),
        payload: { personId: 'administrator' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: 'GET',
        url: '/api/projects/outside-project/participants',
        headers: proxyHeaders('administrator@example.com'),
      })
    ).statusCode,
  ).toBe(200);
});
