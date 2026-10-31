/** Built CLI and production services on disposable data; never touches a running installation. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { ConfigService } = require('@nestjs/config');
const { AuthConfigService } = require('../dist/auth/auth-config.service');
const { LocalAuthService } = require('../dist/auth/local-auth.service');
const {
  InitialAdminService,
  INITIAL_ADMIN_COOKIE,
} = require('../dist/auth/initial-admin.service');
const schema = require('../dist/database/schema');

const directory = mkdtempSync(join(tmpdir(), 'mergeron-initial-admin-smoke-'));
let sqlite;
void (async () => {
  try {
    const database = join(directory, 'webui.sqlite');
    sqlite = new Database(database);
    for (const { tag } of JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ).entries)
      sqlite.exec(readFileSync(`drizzle/${tag}.sql`, 'utf8'));
    const env = {
      ...process.env,
      WEBUI_DB_PATH: database,
      CODEX_HOME: directory,
      WEBUI_AUTH_CONFIG_PATH: join(directory, 'auth.json'),
    };
    const run = () =>
      spawnSync(process.execPath, [resolve('scripts/setup-admin.cjs')], {
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
    assert.notEqual(
      run().status,
      0,
      'Console activation must require Manager authorization',
    );
    writeFileSync(
      join(directory, 'webui-initial-admin.json'),
      JSON.stringify({
        version: 1,
        installationId: '12345678-1111-4111-8111-123456789abc',
        state: 'armed',
      }),
      { mode: 0o600 },
    );
    const activation = run();
    assert.equal(activation.status, 0, activation.stderr);
    const code = activation.stdout.trim();
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    const db = drizzle(sqlite, { schema }),
      config = new ConfigService({ CODEX_HOME: directory });
    const local = new LocalAuthService(db, new AuthConfigService(config)),
      service = new InitialAdminService(db, config, local);
    const grant = service.verify(code);
    await service.complete(`${INITIAL_ADMIN_COOKIE}=${grant.grant}`, {
      firstName: 'Smoke',
      lastName: 'Administrator',
      email: 'smoke@example.test',
      username: 'smoke.admin',
      password: 'smoke-test-password-only',
      passwordConfirmation: 'smoke-test-password-only',
      csrfToken: grant.csrfToken,
    });
    assert.equal(service.status().required, false);
    assert.notEqual(
      run().status,
      0,
      'An existing administrator cannot reopen setup',
    );
    const session = await local.login(
      'smoke.admin',
      'smoke-test-password-only',
    );
    assert.ok(session.personId);
    console.log(
      'Initial administrator passed: built console helper, single-use activation, atomic account, normal login and permanent closure.',
    );
  } finally {
    sqlite?.close();
    rmSync(directory, { recursive: true, force: true });
  }
})().catch(() => {
  console.error('Initial-administrator smoke test failed');
  process.exitCode = 1;
});
