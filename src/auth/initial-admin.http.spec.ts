import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { ApiKeyGuard } from './api-key.guard';
import { AuthService } from './auth.service';
import { AuthConfigService } from './auth-config.service';
import { LocalAuthService } from './local-auth.service';
import {
  InitialAdminService,
  INITIAL_ADMIN_COOKIE,
} from './initial-admin.service';
import { InitialAdminController } from './initial-admin.controller';

@Controller('private-probe')
class PrivateController {
  @Get() read() {
    return { secret: 'protected' };
  }
}
let app: NestFastifyApplication,
  service: InitialAdminService,
  database: TestDatabase,
  directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'initial-admin-http-'));
  database = createTestDatabase();
  const config = new ConfigService({
    CODEX_HOME: directory,
    MERGERON_PUBLIC_URL: 'https://mergeron.example.test',
  });
  const local = new LocalAuthService(
    database.db,
    new AuthConfigService(config),
  );
  service = new InitialAdminService(database.db, config, local);
  writeFileSync(
    service.markerPath,
    JSON.stringify({
      version: 1,
      installationId: '12345678-1111-4111-8111-123456789abc',
      state: 'armed',
    }),
    { mode: 0o600 },
  );
  const module = await Test.createTestingModule({
    controllers: [InitialAdminController, PrivateController],
    providers: [
      { provide: InitialAdminService, useValue: service },
      { provide: LocalAuthService, useValue: local },
      {
        provide: AuthService,
        useValue: {
          authenticateToken: vi.fn().mockResolvedValue({ ok: false }),
        },
      },
      { provide: APP_GUARD, useClass: ApiKeyGuard },
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
  rmSync(directory, { recursive: true, force: true });
});
const origin = { origin: 'https://mergeron.example.test' };
it('allows only the restricted setup endpoints before login, never ordinary protected data', async () => {
  const status = await app.inject({
    method: 'GET',
    url: '/api/auth/setup/status',
  });
  expect(status.statusCode).toBe(200);
  expect(status.headers['cache-control']).toBe('no-store');
  expect(status.json()).toMatchObject({ required: true, authorized: false });
  expect(
    (await app.inject({ method: 'GET', url: '/api/private-probe' })).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup/issue-code',
        headers: origin,
        payload: {},
      })
    ).statusCode,
  ).toBe(404);
});
it('exchanges a single-use code for a restricted secure cookie, then creates and closes the installation', async () => {
  const code = service.issueCode();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup/verify',
        headers: { origin: 'https://evil.example.test' },
        payload: { code },
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/setup/verify',
    headers: origin,
    payload: { code },
  });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  expect(cookie).toMatch(new RegExp('^' + INITIAL_ADMIN_COOKIE + '='));
  expect(response.headers['set-cookie']).toContain('Secure; SameSite=Strict');
  expect(response.json()).not.toHaveProperty('grant');
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/private-probe',
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(401);
  const body = {
    firstName: 'Initial',
    lastName: 'Admin',
    email: 'admin@example.test',
    username: 'first.admin',
    password: 'a-long-password',
    passwordConfirmation: 'a-long-password',
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup/complete',
        headers: { ...origin, cookie },
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  const complete = await app.inject({
    method: 'POST',
    url: '/api/auth/setup/complete',
    headers: { ...origin, cookie },
    payload: {
      ...body,
      csrfToken: response.json<{ csrfToken: string }>().csrfToken,
    },
  });
  expect(complete.statusCode).toBe(200);
  expect(complete.json()).toEqual({ completed: true });
  expect(complete.headers['set-cookie']).toContain('Max-Age=0');
  expect(
    (await app.inject({ method: 'GET', url: '/api/auth/setup/status' })).json<{
      required: boolean;
    }>().required,
  ).toBe(false);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup/verify',
        headers: origin,
        payload: { code },
      })
    ).statusCode,
  ).toBe(401);
});
