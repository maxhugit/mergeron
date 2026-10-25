/** Real built services and isolated SQLite only. No account or provider is contacted. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');
const { verifySync } = require('@node-rs/argon2');

const directory = mkdtempSync(join(tmpdir(), 'mergeron-local-bootstrap-'));
try {
  const database = join(directory, 'webui.sqlite');
  const db = new Database(database);
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  );
  for (const { tag } of journal.entries)
    db.exec(readFileSync(`drizzle/${tag}.sql`, 'utf8'));
  db.close();
  const password = 'fixture-password-never-a-real-account';
  const person = {
    reference: 'FIXTURE-ADMIN',
    firstName: 'Fixture',
    lastName: 'Administrator',
    email: 'fixture@example.test',
    phone: '+33600000000',
    active: true,
    role: 'administrator',
    localAccount: { username: 'fixture-admin', password },
  };
  const run = (input) =>
    spawnSync(process.execPath, [resolve('scripts/provision-person.cjs')], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: {
        ...process.env,
        WEBUI_DB_PATH: database,
        CODEX_HOME: directory,
        WEBUI_AUTH_CONFIG_PATH: join(directory, 'auth.json'),
      },
      timeout: 15000,
    });
  const result = run(person);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(password));
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.localAccountConfigured, true);
  assert.equal(summary.localAuthenticationEnabled, true);
  const check = new Database(database);
  const credential = check
    .prepare('SELECT * FROM local_auth_credentials')
    .get();
  assert.equal(credential.username, 'fixture-admin');
  assert.ok(verifySync(credential.password_hash, password));
  assert.match(credential.password_hash, /^\$argon2id\$/);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM people').get().n, 1);
  const invalid = run({
    ...person,
    reference: 'REJECTED',
    email: 'rejected@example.test',
    localAccount: { username: 'invalid-password', password: 'short' },
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(
    check.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    1,
    'A rejected password must roll back the person',
  );
  assert.equal(
    check.prepare('SELECT COUNT(*) AS n FROM local_auth_credentials').get().n,
    1,
  );
  const duplicate = run({
    ...person,
    reference: 'DUPLICATE',
    email: 'duplicate@example.test',
  });
  assert.notEqual(duplicate.status, 0);
  assert.equal(
    check.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    1,
    'An existing username must never be taken over',
  );
  check.close();
  assert.ok(
    !readdirSync(directory).includes('auth.json'),
    'Provisioning must not change authentication configuration',
  );
  console.log(
    'Local bootstrap passed: password enabled, Argon2id, no default account, rollback and duplicate protection.',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
