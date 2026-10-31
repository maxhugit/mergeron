/** Operator-only activation. No password input, public route, secret file or container-log output. */
require('reflect-metadata');
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { ConfigService } = require('@nestjs/config');
const schema = require('../dist/database/schema');
const { AuthConfigService } = require('../dist/auth/auth-config.service');
const { LocalAuthService } = require('../dist/auth/local-auth.service');
const { InitialAdminService } = require('../dist/auth/initial-admin.service');

let database;
try {
  const argumentsList = process.argv.slice(2);
  if (
    argumentsList.some((value) => value !== '--retry-interrupted') ||
    argumentsList.length > 1
  )
    throw new Error(
      'Usage: node /app/scripts/setup-admin.cjs [--retry-interrupted]',
    );
  if (!process.env.WEBUI_DB_PATH)
    throw new Error(
      'WEBUI_DB_PATH must identify the migrated application database',
    );
  database = new Database(process.env.WEBUI_DB_PATH, { fileMustExist: true });
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  const db = drizzle(database, { schema }),
    config = new ConfigService();
  const service = new InitialAdminService(
    db,
    config,
    new LocalAuthService(db, new AuthConfigService(config)),
  );
  // stdout belongs to this docker-exec terminal, not to the running application's logger.
  console.log(service.issueCode(argumentsList.includes('--retry-interrupted')));
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Initial-administrator activation failed',
  );
  process.exitCode = 1;
} finally {
  database?.close();
}
