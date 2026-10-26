import { expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { eq } from 'drizzle-orm';
import { io } from '../../web/node_modules/socket.io-client/build/cjs/index.js';
import { terminalFixture } from '../terminal/terminal.testing';
import { TerminalGateway } from '../terminal/terminal.gateway';
import { TerminalService } from '../terminal/terminal.service';
import { people } from '../database/schema';
import { DRIZZLE_DB } from '../database/database.constants';
import { AuthService } from './auth.service';
import { IdentityService } from './identity.service';

it('enforces person roles on real Socket.IO terminal events and rechecks a downgraded connection', async () => {
  vi.stubEnv('WEBUI_REQUIRE_IDENTITY', 'true');
  const fixture = await terminalFixture();
  fixture.database.db
    .insert(people)
    .values(
      ['standard', 'administrator'].map((role) => ({
        id: role,
        reference: role,
        name: role,
        firstName: 'Test',
        lastName: role,
        phone: '0600000000',
        email: `${role}@example.com`,
        role: role as 'standard' | 'administrator',
        identitySubject: role === 'administrator' ? role : null,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  const module = await Test.createTestingModule({
    imports: [JwtModule.register({})],
    providers: [
      TerminalGateway,
      AuthService,
      IdentityService,
      { provide: TerminalService, useValue: fixture.service },
      { provide: DRIZZLE_DB, useValue: fixture.database.db },
      {
        provide: ConfigService,
        useValue: new ConfigService({ WEBUI_API_KEY: 'isolated-socket-test' }),
      },
    ],
  }).compile();
  const app = module.createNestApplication(new FastifyAdapter(), {
    logger: false,
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0, '127.0.0.1');
  const url = `${await app.getUrl()}/ws`;
  const sockets = ['standard', 'administrator'].map((role) => {
    const options = {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: {
        authorization: 'Bearer isolated-socket-test',
        'x-webui-auth-source': 'authentik',
        'x-webui-auth-subject': role,
        'x-webui-auth-email': `${role}@example.com`,
      },
    };
    return io(url, options);
  });
  const request = (index: number, contextKey: string) =>
    new Promise<{ ok: boolean }>((resolve, reject) => {
      sockets[index]
        .timeout(3000)
        .emit(
          'terminal.list',
          { contextKey },
          (error: Error | null, response: { ok: boolean }) =>
            error ? reject(error) : resolve(response),
        );
    });
  try {
    await expect
      .poll(() => sockets.every((socket) => socket.connected), {
        timeout: 3000,
      })
      .toBe(true);
    expect((await request(0, 'global')).ok).toBe(false);
    expect((await request(0, 'thread:example')).ok).toBe(false);
    expect((await request(1, 'global')).ok).toBe(true);
    const identities = module.get(IdentityService);
    const adminHeaders = {
      'x-webui-auth-source': 'authentik',
      'x-webui-auth-subject': 'administrator',
      'x-webui-auth-email': 'administrator@example.com',
    };
    const token = identities.startImpersonation(
      identities.resolve(adminHeaders),
      adminHeaders,
      'standard',
    );
    const simulatedOptions = {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: {
        ...adminHeaders,
        authorization: 'Bearer isolated-socket-test',
        cookie: `mergeron_impersonation=${token}`,
      },
    };
    sockets.push(io(url, simulatedOptions));
    await expect.poll(() => sockets[2].connected, { timeout: 3000 }).toBe(true);
    expect((await request(2, 'global')).ok).toBe(false);
    identities.stopImpersonation(identities.resolveOriginal(adminHeaders), {
      cookie: `mergeron_impersonation=${token}`,
    });
    expect((await request(2, 'global')).ok).toBe(false);
    fixture.database.db
      .update(people)
      .set({ role: 'standard' })
      .where(eq(people.id, 'administrator'))
      .run();
    expect((await request(1, 'global')).ok).toBe(false);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
    await fixture.dispose();
    fixture.database.sqlite.close();
    vi.unstubAllEnvs();
  }
}, 15000);
