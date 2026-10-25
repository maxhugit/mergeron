import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectWorkspaces,
  projectParticipants,
} from '../database/schema';
import { IdentityService } from './identity.service';
import {
  PlatformAccessGuard,
  type IdentityRequest,
} from './platform-access.guard';
import { AuthService } from './auth.service';
import { ProjectsService } from '../projects/projects.service';

let database: TestDatabase;
let identities: IdentityService;
let auth: AuthService;
let guard: PlatformAccessGuard;
let directory: string;
const headers = (
  subject = 'standard-subject',
  email = 'standard@example.com',
) => ({
  'x-webui-auth-source': 'authentik',
  'x-webui-auth-subject': subject,
  'x-webui-auth-email': email,
});
function http(
  url: string,
  method = 'GET',
  extra: Partial<IdentityRequest> = {},
) {
  const request: IdentityRequest = {
    headers: headers(),
    url: `/api${url}`,
    method,
    ...extra,
  };
  const context = {
    getType: () => 'http',
    getClass: () => Object,
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { request, context };
}
function ws(event: string, data: Record<string, unknown>) {
  return {
    getType: () => 'ws',
    getClass: () => Object,
    getHandler: () => () => undefined,
    switchToWs: () => ({
      getClient: () => ({ handshake: { headers: headers() } }),
      getData: () => data,
      getPattern: () => event,
    }),
  } as unknown as ExecutionContext;
}
beforeEach(() => {
  vi.stubEnv('WEBUI_REQUIRE_IDENTITY', 'true');
  directory = mkdtempSync(join(tmpdir(), 'codex-role-tests-'));
  mkdirSync(join(directory, 'workspace'));
  mkdirSync(join(directory, 'private'));
  database = createTestDatabase();
  const now = Date.now();
  database.db
    .insert(people)
    .values([
      {
        id: 'standard',
        reference: 'STD',
        name: 'Test Standard',
        firstName: 'Test',
        lastName: 'Standard',
        phone: '0600000000',
        email: 'standard@example.com',
        role: 'standard',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'admin',
        reference: 'ADM',
        name: 'Test Admin',
        firstName: 'Test',
        lastName: 'Admin',
        phone: '0600000001',
        email: 'admin@example.com',
        role: 'administrator',
        identitySubject: 'admin-subject',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Test',
      workspacePath: join(directory, 'workspace'),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  identities = new IdentityService(database.db);
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'standard', createdAt: now })
    .run();
  auth = new AuthService(
    new ConfigService({ WEBUI_API_KEY: 'isolated-test-key' }),
    new JwtService(),
    identities,
  );
  guard = new PlatformAccessGuard(identities, new Reflector(), auth);
});
afterEach(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('binds only provisioned email records, then follows the stable subject instead of email changes', () => {
  expect(
    identities.resolve(headers('stable', 'STANDARD@EXAMPLE.COM')),
  ).toMatchObject({ personId: 'standard', role: 'standard', active: true });
  expect(
    identities.resolve(headers('stable', 'changed@example.com')),
  ).toMatchObject({ personId: 'standard' });
  expect(
    identities.resolve(headers('attacker', 'standard@example.com')).active,
  ).toBe(false);
  expect(
    identities.resolve(headers('unknown', 'new@example.com')).role,
  ).toBeNull();
  expect(identities.resolve({}).active).toBe(false);
  expect(identities.resolve({ 'x-webui-auth-source': 'invalid' }).active).toBe(
    false,
  );
});

it('refuses unknown and disabled accounts without bootstrapping an administrator', () => {
  expect(
    guard.canActivate(
      http('/auth/me', 'GET', {
        headers: headers('unknown', 'new@example.com'),
      }).context,
    ),
  ).toBe(true);
  expect(() =>
    guard.canActivate(
      http('/projects', 'GET', {
        headers: headers('unknown', 'new@example.com'),
      }).context,
    ),
  ).toThrow('active person');
  database.db
    .update(people)
    .set({ active: false })
    .where(eq(people.id, 'standard'))
    .run();
  expect(() => guard.canActivate(http('/projects').context)).toThrow(
    'active person',
  );
});

it('never grants the first administrator login from an email match alone', () => {
  database.db
    .update(people)
    .set({ identitySubject: null })
    .where(eq(people.id, 'admin'))
    .run();
  expect(
    identities.resolve(headers('claiming-admin-email', 'admin@example.com'))
      .active,
  ).toBe(false);
  expect(
    database.db.select().from(people).where(eq(people.id, 'admin')).get()
      ?.identitySubject,
  ).toBeNull();
});

it('links OIDC email only when verified and still recognizes an explicitly linked administrator', () => {
  expect(
    identities.resolveOidc('unverified-subject', 'standard@example.com', false)
      .active,
  ).toBe(false);
  expect(
    database.db.select().from(people).where(eq(people.id, 'standard')).get()
      ?.identitySubject,
  ).toBeNull();
  expect(
    identities.resolveOidc('verified-subject', 'STANDARD@EXAMPLE.COM', true),
  ).toMatchObject({ personId: 'standard', active: true });
  expect(
    identities.resolveOidc('admin-subject', 'admin@example.com', false),
  ).toMatchObject({ personId: 'admin', role: 'administrator', active: true });
});

it.each([
  '/settings',
  '/settings/manager/backups',
  '/settings/manager/backups/delete',
  '/settings/general.onlyofficeJwtSecret',
  '/codex/config/raw',
  '/codex/catalog/draft',
  '/codex/cli',
  '/codex/cli/update',
  '/codex/cli/rollback',
  '/account',
  '/mcp-servers',
  '/logs/export',
  '/logs/storage',
  '/logs/retention',
  '/database/status',
  '/plugins',
  '/simple-chat/api-key',
  '/simple-chat/settings',
  '/projects/project-1/knowledge/proposals',
])(
  'blocks standard access to %s even with a direct request or a forged body role',
  (path) => {
    expect(() =>
      guard.canActivate(
        http(path, 'GET', { body: { role: 'administrator' } }).context,
      ),
    ).toThrow('Administrator access');
    expect(() => guard.canActivate(http(path, 'PATCH').context)).toThrow(
      'Administrator access',
    );
    expect(
      guard.canActivate(
        http(path, 'GET', {
          headers: headers('admin-subject', 'admin@example.com'),
        }).context,
      ),
    ).toBe(true);
  },
);

it.each([
  '/projects/project-1/mcp-servers',
  '/projects/project-1/apps',
  '/projects/project-1/agent-settings',
  '/projects/project-1/workspace-resources',
  '/projects/project-1/workspace-resources/resource-1/test',
  '/projects/project-1/participants',
  '/projects/project-1/participants/person-1',
])('blocks standard project configuration writes to %s', (path) => {
  expect(() => guard.canActivate(http(path, 'PATCH').context)).toThrow(
    'Administrator access',
  );
  expect(
    guard.canActivate(
      http(path, 'PATCH', {
        headers: headers('admin-subject', 'admin@example.com'),
      }).context,
    ),
  ).toBe(true);
});

it('blocks creating or editing people for standard users and rechecks changed roles on every request', () => {
  expect(() =>
    guard.canActivate(
      http('/projects/people', 'POST', { body: { role: 'administrator' } })
        .context,
    ),
  ).toThrow('Administrator access');
  const admin = http('/settings', 'PATCH', {
    headers: headers('admin-subject', 'admin@example.com'),
  });
  expect(guard.canActivate(admin.context)).toBe(true);
  database.db
    .update(people)
    .set({ role: 'standard' })
    .where(eq(people.id, 'admin'))
    .run();
  expect(() => guard.canActivate(admin.context)).toThrow(
    'Administrator access',
  );
  expect(guard.canActivate(http('/auth/client-config').context)).toBe(true);
});

it('refuses global terminal operations including attach/input on existing sessions', () => {
  for (const event of [
    'terminal.open',
    'terminal.list',
    'terminal.reconnect',
    'terminal.recover',
    'terminal.input',
    'terminal.download',
    'terminal.close',
  ]) {
    expect(() =>
      guard.canActivate(
        ws(event, { contextKey: 'global', terminalId: 'existing' }),
      ),
    ).toThrow('Administrator access');
    expect(() =>
      guard.canActivate(ws(event, { contextKey: 'thread:test' })),
    ).toThrow('Administrator access');
  }
  expect(() =>
    guard.canActivate(
      ws('terminal.open', {
        contextKey: 'thread:test',
        cwd: join(directory, 'private'),
      }),
    ),
  ).toThrow('Administrator access');
});

it('reserves agent and automation execution for administrators while allowing simple chat and manual tasks', () => {
  for (const path of [
    '/threads',
    '/threads/t/turns',
    '/threads/t/review',
    '/projects/p/resources/r/automations',
  ]) {
    expect(() => guard.canActivate(http(path, 'POST').context)).toThrow(
      'Administrator access',
    );
  }
  expect(() =>
    guard.canActivate(ws('codex.serverResponse', { decision: 'accept' })),
  ).toThrow('Administrator access');
  expect(
    guard.canActivate(http('/simple-chat/threads/t/messages', 'POST').context),
  ).toBe(true);
  expect(
    guard.canActivate(http('/projects/p/resources/r/tasks', 'POST').context),
  ).toBe(true);
});

it('confines interactive files and watchers to project workspaces, including symlinks and new paths', () => {
  const workspace = join(directory, 'workspace');
  symlinkSync(join(directory, 'private'), join(workspace, 'escape'));
  expect(
    guard.canActivate(
      http('/files/read', 'GET', {
        query: { path: join(workspace, 'new.txt') },
      }).context,
    ),
  ).toBe(true);
  for (const path of [
    join(directory, 'private/a.txt'),
    join(workspace, '../private/a.txt'),
    join(workspace, 'escape/new.txt'),
  ]) {
    expect(() =>
      guard.canActivate(
        http('/files/preview', 'GET', { query: { path } }).context,
      ),
    ).toThrow('project workspaces');
    expect(() => guard.canActivate(ws('fs.watch.acquire', { path }))).toThrow(
      'project workspaces',
    );
  }
});

it('only accepts signed, path-bound document transfers and never accepts a general login token', async () => {
  const path = '/workspaces/document.docx';
  const signed = auth.signFileAccess(path);
  const request = (token: string, target = path) =>
    http('/files/serve', 'GET', {
      headers: { 'x-webui-auth-source': 'document' },
      query: { path: target, access_token: token },
    }).context;
  expect(guard.canActivate(request(signed))).toBe(true);
  expect(
    guard.canActivate(request(signed, '/home/codex/.codex/auth.json')),
  ).toBe(false);
  expect(guard.canActivate(request((await auth.signJwt()).accessToken))).toBe(
    false,
  );
  expect(guard.canActivate(request('isolated-test-key'))).toBe(false);
});

it('protects deployment private paths even if a project links a broad parent directory', () => {
  database.db
    .update(projects)
    .set({ workspacePath: directory })
    .where(eq(projects.id, 'p'))
    .run();
  vi.stubEnv('WEBUI_PROTECTED_PATHS', join(directory, 'private'));
  expect(() =>
    identities.requireWorkspacePath(join(directory, 'private/config.json')),
  ).toThrow('private paths');
  expect(() => identities.requireWorkspacePath(directory)).toThrow(
    'private paths',
  );
  expect(() =>
    identities.requireWorkspacePath(join(directory, 'workspace/a.txt')),
  ).not.toThrow();
});

it('also protects physical workspace deletion through project and legacy workspace endpoints', () => {
  const privatePath = join(directory, 'private');
  vi.stubEnv('WEBUI_PROTECTED_PATHS', privatePath);
  database.db
    .insert(projectWorkspaces)
    .values({
      id: 'private-workspace',
      projectId: 'p',
      name: 'Private',
      path: privatePath,
      primary: false,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  expect(() =>
    guard.canActivate(
      http('/projects/p', 'DELETE', {
        body: { deleteWorkspaceIds: ['private-workspace'] },
      }).context,
    ),
  ).toThrow('Administrator access');
  expect(() =>
    guard.canActivate(
      http('/workspaces/name', 'DELETE', {
        params: { name: '../../home/codex' },
      }).context,
    ),
  ).toThrow();
});

it('requires person contact fields, computes the name server-side and protects the last administrator', () => {
  const service = new ProjectsService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    database.db,
  );
  const input = {
    reference: 'NEW',
    firstName: '  Alice ',
    lastName: ' Test ',
    email: ' Alice@example.com ',
    phone: '0600000002',
  };
  expect(service.savePerson({ ...input, name: 'forged' })).toMatchObject({
    name: 'Alice Test',
    email: 'alice@example.com',
    role: 'standard',
  });
  expect(() =>
    service.savePerson({ ...input, reference: 'A', email: '' }),
  ).toThrow('Email is required');
  expect(() => service.savePerson({ ...input, phone: '' })).toThrow();
  expect(() => service.savePerson({ ...input, firstName: '' })).toThrow();
  expect(() => service.savePerson({ ...input, role: 'superuser' })).toThrow(
    'Invalid platform role',
  );
  expect(() => service.savePerson({ active: false }, 'admin')).toThrow(
    'last active administrator',
  );
  expect(() => service.savePerson({ role: 'standard' }, 'admin')).toThrow(
    'last active administrator',
  );
  service.savePerson({
    ...input,
    reference: 'UNLINKED-ADMIN',
    email: 'unlinked-admin@example.com',
    role: 'administrator',
  });
  expect(() => service.savePerson({ role: 'standard' }, 'admin')).toThrow(
    'last active administrator',
  );
});
