import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  authSessions,
  localAuthCredentials,
  people,
  projects,
  settings,
} from '../database/schema';
import { AuthConfigService } from './auth-config.service';
import { LocalAuthService } from './local-auth.service';
import {
  InitialAdminService,
  INITIAL_ADMIN_COOKIE,
  INITIAL_ADMIN_KEY,
} from './initial-admin.service';
import { documentIsolationArgs } from '../document-publication/document-isolation';

let database: TestDatabase,
  directory: string,
  config: ConfigService,
  local: LocalAuthService,
  service: InitialAdminService;
const details = {
  firstName: 'First',
  lastName: 'Administrator',
  email: 'admin@example.test',
  username: 'initial.admin',
  password: 'a-long-initial-password',
  passwordConfirmation: 'a-long-initial-password',
};
function arm() {
  writeFileSync(
    service.markerPath,
    JSON.stringify({
      version: 1,
      installationId: '12345678-1111-4111-8111-123456789abc',
      state: 'armed',
    }),
    { mode: 0o600 },
  );
}
function grant() {
  const code = service.issueCode(),
    result = service.verify(code);
  return { code, cookie: `${INITIAL_ADMIN_COOKIE}=${result.grant}`, ...result };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mergeron-initial-admin-'));
  database = createTestDatabase();
  config = new ConfigService({
    CODEX_HOME: directory,
    MERGERON_PUBLIC_URL: 'https://mergeron.example.test',
    MERGERON_STACK_PREFIX: 'mergeron-dev',
  });
  local = new LocalAuthService(database.db, new AuthConfigService(config));
  service = new InitialAdminService(database.db, config, local);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

it('never offers setup merely because no administrator exists', () => {
  expect(service.status()).toEqual({ required: false, authorized: false });
  expect(() => service.issueCode()).toThrow('unavailable');
  expect(() => service.verify('x'.repeat(43))).toThrow('Invalid or expired');
});
it('requires Manager authorization and rejects symlinks or malformed state without enabling anything', () => {
  writeFileSync(join(directory, 'target'), '{}');
  symlinkSync(join(directory, 'target'), service.markerPath);
  expect(() => service.status()).toThrow();
  unlinkSync(service.markerPath);
  writeFileSync(service.markerPath, '{}', { mode: 0o600 });
  expect(() => service.status()).toThrow('Invalid first-administrator');
});
it('does not open an existing installation with people or projects even if an armed marker is present', () => {
  arm();
  database.db
    .insert(people)
    .values({
      id: 'old',
      reference: 'OLD',
      name: 'Existing',
      active: false,
      role: 'standard',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  expect(service.status().required).toBe(false);
  expect(() => service.issueCode()).toThrow('unavailable');
  database.db.delete(people).run();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Existing',
      workspacePath: '/workspaces/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  expect(service.status().required).toBe(false);
});
it('only exposes safe status, stores token hashes, and invalidates previous codes and grants on console reissue', () => {
  arm();
  const first = grant();
  expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const raw = database.db
    .select()
    .from(settings)
    .where(eq(settings.key, INITIAL_ADMIN_KEY))
    .get()!.value!;
  expect(raw).not.toContain(first.code);
  expect(raw).not.toContain(first.grant);
  expect(service.status(first.cookie)).toMatchObject({
    required: true,
    authorized: true,
    csrfToken: first.csrfToken,
    containerName: 'mergeron-dev-ui',
  });
  expect(service.status()).not.toHaveProperty('csrfToken');
  expect(service.status()).not.toHaveProperty('installationId');
  expect(() => service.verify(first.code)).toThrow('Invalid or expired');
  const next = service.issueCode();
  expect(service.status(first.cookie).authorized).toBe(false);
  expect(() => service.verify(first.code)).toThrow('Invalid or expired');
  expect(service.verify(next).grant).not.toBe(first.grant);
});
it('expires the activation code and setup cookie after 15 minutes and bounds brute-force attempts persistently', () => {
  arm();
  vi.useFakeTimers();
  const code = service.issueCode();
  for (let attempt = 0; attempt < 10; attempt++)
    expect(() => service.verify('x'.repeat(43))).toThrow('Invalid or expired');
  const restarted = new InitialAdminService(database.db, config, local);
  expect(() => restarted.verify(code)).toThrow('Invalid or expired');
  vi.advanceTimersByTime(60001);
  const result = restarted.verify(code);
  vi.advanceTimersByTime(15 * 60_000);
  expect(
    restarted.status(`${INITIAL_ADMIN_COOKIE}=${result.grant}`).authorized,
  ).toBe(false);
  expect(() => restarted.verify(code)).toThrow('Invalid or expired');
});
it('pins unsafe requests to the configured HTTPS origin, not caller-supplied hosts', () => {
  expect(() =>
    service.requireOrigin('https://mergeron.example.test'),
  ).not.toThrow();
  for (const origin of [
    null,
    'http://mergeron.example.test',
    'https://evil.example.test',
    'https://mergeron.example.test:8443',
  ])
    expect(() => service.requireOrigin(origin)).toThrow(
      'configured HTTPS origin',
    );
});
it('requires both the restricted HttpOnly session and CSRF proof before hashing or writing account data', async () => {
  arm();
  const selected = grant();
  const hash = vi.spyOn(local, 'prepareNewAccount');
  await expect(
    service.complete(undefined, { ...details, csrfToken: selected.csrfToken }),
  ).rejects.toThrow('setup session');
  await expect(
    service.complete(selected.cookie, { ...details, csrfToken: 'bad' }),
  ).rejects.toThrow('CSRF');
  await expect(
    service.complete(selected.cookie, {
      ...details,
      csrfToken: selected.csrfToken,
      role: 'administrator',
    }),
  ).rejects.toThrow('Invalid setup');
  expect(hash).not.toHaveBeenCalled();
  expect(database.db.select().from(people).all()).toHaveLength(0);
  expect(service.cookie(selected.grant, selected.expiresAt)).toMatch(
    /HttpOnly; Secure; SameSite=Strict/,
  );
});
it('creates the person and Argon2 credential atomically, closes setup, then allows only normal login', async () => {
  arm();
  const selected = grant();
  await expect(
    service.complete(selected.cookie, {
      ...details,
      csrfToken: selected.csrfToken,
    }),
  ).resolves.toEqual({ completed: true });
  const person = database.db.select().from(people).get()!;
  expect(person).toMatchObject({
    role: 'administrator',
    active: true,
    firstName: 'First',
    reference: 'ADM-001',
  });
  expect(
    database.db.select().from(localAuthCredentials).get()!.passwordHash,
  ).toMatch(/^\$argon2id\$/);
  expect(database.db.select().from(authSessions).all()).toHaveLength(0);
  expect(service.status()).toEqual({ required: false, authorized: false });
  expect(
    (JSON.parse(readFileSync(service.markerPath, 'utf8')) as { state: string })
      .state,
  ).toBe('closed');
  await expect(
    local.login(details.username, details.password),
  ).resolves.toHaveProperty('personId', person.id);
  await expect(
    service.complete(selected.cookie, {
      ...details,
      csrfToken: selected.csrfToken,
    }),
  ).rejects.toThrow('unavailable');
  expect(() => service.issueCode(true)).toThrow('unavailable');
});
it('cannot reopen by deleting people, setup DB state or restoring a pre-setup database', async () => {
  arm();
  const selected = grant();
  await service.complete(selected.cookie, {
    ...details,
    csrfToken: selected.csrfToken,
  });
  database.db.delete(authSessions).run();
  database.db.delete(localAuthCredentials).run();
  database.db.delete(people).run();
  database.db.delete(settings).where(eq(settings.key, INITIAL_ADMIN_KEY)).run();
  expect(
    new InitialAdminService(database.db, config, local).status().required,
  ).toBe(false);
  expect(() => service.issueCode()).toThrow('unavailable');
  expect(() => service.issueCode(true)).toThrow('unavailable');
});
it('permits only one completion when two submissions hash concurrently', async () => {
  arm();
  const selected = grant();
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      service.complete(selected.cookie, {
        ...details,
        csrfToken: selected.csrfToken,
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(database.db.select().from(people).all()).toHaveLength(1);
  expect(database.db.select().from(localAuthCredentials).all()).toHaveLength(1);
});

it('rechecks console invalidation after password hashing, before sealing or writing any person', async () => {
  arm();
  const selected = grant();
  const credential = await local.prepareNewAccount(details);
  let finish!: (value: typeof credential) => void;
  vi.spyOn(local, 'prepareNewAccount').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const completion = service.complete(selected.cookie, {
    ...details,
    csrfToken: selected.csrfToken,
  });
  const replacement = service.issueCode();
  finish(credential);
  await expect(completion).rejects.toThrow('Setup changed');
  expect(database.db.select().from(people).all()).toHaveLength(0);
  expect(service.verify(replacement)).toHaveProperty('grant');
});
it('seals before DB commit and requires an explicit console retry after an interrupted transaction', async () => {
  arm();
  const selected = grant();
  database.sqlite.exec(
    "CREATE TRIGGER deny_initial_credential BEFORE INSERT ON local_auth_credentials BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;",
  );
  await expect(
    service.complete(selected.cookie, {
      ...details,
      csrfToken: selected.csrfToken,
    }),
  ).rejects.toThrow();
  expect(database.db.select().from(people).all()).toHaveLength(0);
  expect(database.db.select().from(localAuthCredentials).all()).toHaveLength(0);
  expect(service.status().required).toBe(false);
  expect(() => service.issueCode()).toThrow('unavailable');
  database.sqlite.exec('DROP TRIGGER deny_initial_credential');
  database.sqlite.exec(
    "CREATE TRIGGER deny_setup_retry BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'simulated setup persistence failure'); END;",
  );
  expect(() => service.issueCode(true)).toThrow();
  expect(service.status().required).toBe(false);
  database.sqlite.exec('DROP TRIGGER deny_setup_retry');
  expect(service.verify(service.issueCode(true))).toHaveProperty('grant');
});
it('masks the authorization marker from agent processes as well as the database', () => {
  arm();
  const args = documentIsolationArgs(
    {
      home: directory,
      databasePath: join(directory, 'test.sqlite'),
      writableRoots: ['/workspaces'],
      publishedRoots: [],
    },
    'codex',
    [],
  );
  const index = args.indexOf(service.markerPath);
  expect(args.slice(index - 2, index + 1)).toEqual([
    '--ro-bind',
    '/dev/null',
    service.markerPath,
  ]);
});
