import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../database/database.testing';
import { authSessions, localAuthCredentials, people } from '../database/schema';
import { AuthConfigService } from './auth-config.service';
import { LocalAuthService } from './local-auth.service';

describe('LocalAuthService', () => {
  const database = createTestDatabase();
  let directory: string;
  let configuration: AuthConfigService;
  let service: LocalAuthService;

  beforeEach(() => {
    database.db.delete(authSessions).run();
    database.db.delete(localAuthCredentials).run();
    database.db.delete(people).run();
    directory = mkdtempSync(join(tmpdir(), 'webui-local-auth-'));
    configuration = new AuthConfigService({
      get: (key: string) =>
        key === 'WEBUI_AUTH_CONFIG_PATH'
          ? join(directory, 'auth.json')
          : undefined,
    } as ConfigService);
    service = new LocalAuthService(database.db, configuration);
    const now = Date.now();
    database.db
      .insert(people)
      .values({
        id: 'admin',
        reference: 'admin',
        name: 'Administrator',
        email: 'admin@example.test',
        role: 'administrator',
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  afterAll(() => database.sqlite.close());

  it('offers only password authentication by default without allowing unprovisioned logins', async () => {
    expect(service.methods()).toMatchObject({
      localEnabled: true,
      oidcEnabled: false,
      oidcAutoRedirect: false,
    });
    await expect(
      service.login('admin', 'unprovisioned-password'),
    ).rejects.toThrow('Invalid username or password');
    expect(database.db.select().from(localAuthCredentials).all()).toHaveLength(
      0,
    );
    expect(database.db.select().from(authSessions).all()).toHaveLength(0);
  });

  it('creates an Argon2id credential and a revocable opaque session', async () => {
    await service.setAccount('admin', {
      username: 'maxime',
      password: 'a-secure-password',
    });
    const credential = database.db.select().from(localAuthCredentials).get();
    expect(credential?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(credential?.passwordHash).not.toContain('a-secure-password');

    configuration.update({ local: { enabled: true } });
    const session = await service.login(
      'maxime',
      'a-secure-password',
      'test-agent',
    );
    const cookie = service.cookie(session, true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(service.authenticateCookie(cookie)).toBe('admin');
    expect(database.db.select().from(authSessions).get()?.tokenHash).not.toBe(
      session.token,
    );

    service.logout(cookie);
    expect(service.authenticateCookie(cookie)).toBeNull();
  });

  it('rejects a local password for a person already linked to SSO', async () => {
    database.db.update(people).set({ identitySubject: 'authentik-user' }).run();

    await expect(
      service.setAccount('admin', {
        username: 'maxime',
        password: 'a-secure-password',
      }),
    ).rejects.toThrow(
      'A local password cannot be configured for an SSO-linked account',
    );
    expect(
      database.db.select().from(localAuthCredentials).get(),
    ).toBeUndefined();
  });

  it('locks an account after the configured number of failed attempts', async () => {
    await service.setAccount('admin', {
      username: 'maxime',
      password: 'a-secure-password',
    });
    configuration.update({
      local: {
        enabled: true,
        maxFailedAttempts: 3,
        lockoutMinutes: 5,
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1)
      await expect(
        service.login('maxime', 'incorrect-password'),
      ).rejects.toThrow('Invalid username or password');

    expect(
      database.db.select().from(localAuthCredentials).get()?.lockedUntil,
    ).toBeGreaterThan(Date.now());
    await expect(service.login('maxime', 'a-secure-password')).rejects.toThrow(
      'Invalid username or password',
    );
  });

  it('rejects local cookies while local authentication is disabled', async () => {
    await service.setAccount('admin', {
      username: 'maxime',
      password: 'a-secure-password',
    });
    configuration.update({ local: { enabled: true } });
    const session = await service.login('maxime', 'a-secure-password');
    const cookie = service.cookie(session, true);
    expect(service.authenticateCookie(cookie)).toBe('admin');

    configuration.update({ local: { enabled: false } });
    expect(service.authenticateCookie(cookie)).toBeNull();
  });

  it('revokes every active local session on demand', async () => {
    await service.setAccount('admin', {
      username: 'maxime',
      password: 'a-secure-password',
    });
    configuration.update({ local: { enabled: true } });
    const session = await service.login('maxime', 'a-secure-password');
    const cookie = service.cookie(session, true);

    service.revokeAllSessions();

    expect(service.authenticateCookie(cookie)).toBeNull();
  });

  it('reports recent presence and revokes every session for one person', () => {
    const first = service.createSession('admin', 'first-browser');
    const second = service.createSession('admin', 'second-browser');

    const account = service
      .listAccounts()
      .find((item) => item.personId === 'admin');
    expect(account).toMatchObject({
      connected: true,
      activeSessionCount: 2,
    });
    expect(account?.connectedSince).toBeLessThanOrEqual(account!.lastSeenAt!);

    service.revokePersonSessions('admin');

    expect(service.authenticateCookie(service.cookie(first, true))).toBeNull();
    expect(service.authenticateCookie(service.cookie(second, true))).toBeNull();
    expect(
      service.listAccounts().find((item) => item.personId === 'admin'),
    ).toMatchObject({
      connected: false,
      connectedSince: null,
      lastSeenAt: null,
      activeSessionCount: 0,
    });
  });
});
