import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { people } from '../database/schema';
import { IdentityService } from './identity.service';
import type { LocalAuthService } from './local-auth.service';

let database: TestDatabase;
let identities: IdentityService;
const adminHeaders = {
  'x-webui-auth-source': 'authentik',
  'x-webui-auth-subject': 'admin',
};
beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(people)
    .values(
      ['admin', 'otherAdmin', 'target', 'inactive'].map((id) => ({
        id,
        reference: id,
        name: id,
        role:
          id.includes('Admin') || id === 'admin'
            ? ('administrator' as const)
            : ('standard' as const),
        active: id !== 'inactive',
        identitySubject: id,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  identities = new IdentityService(database.db);
});
afterEach(() => {
  database.sqlite.close();
  vi.useRealTimers();
});
function start(target = 'target') {
  const raw = identities.resolveOriginal(adminHeaders);
  const token = identities.startImpersonation(raw, adminHeaders, target);
  return {
    raw,
    token,
    headers: { ...adminHeaders, cookie: `mergeron_impersonation=${token}` },
  };
}
it('rejects forged tokens, different administrators, inactive targets and chained impersonation', () => {
  expect(
    identities.resolve({
      ...adminHeaders,
      cookie: 'mergeron_impersonation=forged',
    }).active,
  ).toBe(false);
  expect(() => start('inactive')).toThrow();
  const session = start();
  expect(identities.resolve(session.headers)).toMatchObject({
    personId: 'target',
    role: 'standard',
    impersonation: { administratorId: 'admin' },
  });
  expect(
    identities.resolve({
      ...session.headers,
      'x-webui-auth-subject': 'otherAdmin',
    }).active,
  ).toBe(false);
  expect(() =>
    identities.startImpersonation(session.raw, session.headers, 'otherAdmin'),
  ).toThrow();
  expect(() =>
    identities.startImpersonation(
      identities.resolveOriginal({ 'x-webui-auth-source': 'service' }),
      {},
      'target',
    ),
  ).toThrow();
});
it('expires closed and never restores administrative privileges to a stale identity', () => {
  vi.useFakeTimers();
  const session = start('otherAdmin');
  const identity = identities.resolve(session.headers);
  vi.advanceTimersByTime(15 * 60_000 + 1);
  expect(identities.resolve(session.headers).active).toBe(false);
  expect(identities.canReadProject(identity, 'anything')).toBe(false);
  expect(() => identities.requireAdministrator(identity)).toThrow();
  identities.stopImpersonation(session.raw, session.headers);
  expect(identities.resolve(session.headers).active).toBe(false);
  expect(identities.resolve(adminHeaders).role).toBe('administrator');
});
it('rechecks revocation of the real administrator and the target', () => {
  const session = start();
  database.db
    .update(people)
    .set({ active: false })
    .where(eq(people.id, 'target'))
    .run();
  expect(identities.resolve(session.headers).active).toBe(false);
  database.db
    .update(people)
    .set({ active: true })
    .where(eq(people.id, 'target'))
    .run();
  database.db
    .update(people)
    .set({ role: 'standard' })
    .where(eq(people.id, 'admin'))
    .run();
  expect(identities.resolve(session.headers).active).toBe(false);
});
it('binds document capabilities to the test lifetime and audits document writes', () => {
  const raw = identities.resolveOriginal(adminHeaders);
  const oldCapability = identities.createDocumentSession(
    raw,
    '/tmp/impersonation-fixture.docx',
    true,
  );
  const session = start('otherAdmin');
  expect(
    identities.verifyDocumentSession(
      oldCapability,
      '/tmp/impersonation-fixture.docx',
      true,
    ),
  ).toBe(false);
  const capability = identities.createDocumentSession(
    identities.resolve(session.headers),
    '/tmp/impersonation-fixture.docx',
    true,
  );
  expect(
    identities.verifyDocumentSession(
      capability,
      '/tmp/impersonation-fixture.docx',
      true,
    ),
  ).toBe(true);
  expect(identities.listImpersonationAudit(raw)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'documentWriteAttempt',
        administratorId: 'admin',
        personId: 'otherAdmin',
      }),
    ]),
  );
  identities.stopImpersonation(raw, session.headers);
  expect(
    identities.verifyDocumentSession(
      capability,
      '/tmp/impersonation-fixture.docx',
      true,
    ),
  ).toBe(false);
});
it('a restart invalidates test cookies and document capabilities without granting the real admin rights', () => {
  const session = start('otherAdmin');
  const capability = identities.createDocumentSession(
    identities.resolve(session.headers),
    '/tmp/impersonation-fixture.docx',
    true,
  );
  const restarted = new IdentityService(database.db);
  expect(restarted.resolve(session.headers).active).toBe(false);
  expect(
    restarted.verifyDocumentSession(
      capability,
      '/tmp/impersonation-fixture.docx',
      true,
    ),
  ).toBe(false);
});

it('applies the same policy to a verified local-session person id, never to a client-supplied target header', () => {
  const local = new IdentityService(database.db, {
    authenticateCookie: () => 'admin',
  } as unknown as LocalAuthService);
  const headers = {
    cookie: 'codex_webui_session=verified-elsewhere',
    'x-impersonate-person': 'otherAdmin',
  };
  const real = local.resolveOriginal(headers);
  expect(real.personId).toBe('admin');
  const token = local.startImpersonation(real, headers, 'target');
  expect(
    local.resolve(
      {
        ...headers,
        cookie: `${headers.cookie}; mergeron_impersonation=${token}`,
      },
      'admin',
    ),
  ).toMatchObject({ personId: 'target', role: 'standard' });
  expect(
    local.resolve(
      {
        ...headers,
        cookie: `${headers.cookie}; mergeron_impersonation=${token}`,
      },
      'otherAdmin',
    ).active,
  ).toBe(false);
});
