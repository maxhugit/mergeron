import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DatabaseService } from './database.service';
import { people, pushSubscriptions } from './schema';

let directory: string | undefined;
let database: DatabaseService | undefined;

afterEach(() => {
  database?.onModuleDestroy();
  database = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('exposes schema and bounded read-only rows while masking secrets', () => {
  directory = mkdtempSync(join(tmpdir(), 'codex-webui-database-'));
  const path = join(directory, 'application.sqlite');
  database = new DatabaseService(new ConfigService({ WEBUI_DB_PATH: path }));
  database.db.run(
    sql`CREATE TABLE browser_owner (id INTEGER PRIMARY KEY, label TEXT)`,
  );
  database.db.run(
    sql`CREATE TABLE browser_test (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES browser_owner(id) ON DELETE CASCADE, name TEXT NOT NULL, api_token TEXT)`,
  );
  database.db.run(
    sql`INSERT INTO browser_test (name, api_token) VALUES ('visible', 'hidden')`,
  );

  const browserTable = database
    .getSchema()
    .objects.find((object) => object.name === 'browser_test');
  expect(browserTable?.type).toBe('table');
  expect(browserTable?.columns).toContainEqual(
    expect.objectContaining({ name: 'name', notNull: true }),
  );
  expect(browserTable?.foreignKeys).toContainEqual(
    expect.objectContaining({
      fromColumn: 'owner_id',
      referencedTable: 'browser_owner',
      toColumn: 'id',
      onDelete: 'CASCADE',
    }),
  );
  expect(database.readTable('browser_test', '1', '25')).toMatchObject({
    table: 'browser_test',
    total: 1,
    rows: [{ id: 1, name: 'visible', api_token: '••••••' }],
    sensitiveValuesMasked: true,
  });
  expect(database.readTable('browser_test', 1, 25, 'VISIBLE')).toMatchObject({
    total: 1,
    search: 'VISIBLE',
  });
  expect(database.readTable('browser_test', 1, 25, 'missing')).toMatchObject({
    total: 0,
    rows: [],
  });
  expect(() => database?.readTable('sqlite_master', 1, 25)).toThrow(
    'Unknown database table',
  );
  expect(() => database?.readTable('browser_test', 1, 101)).toThrow(
    'Invalid database pagination',
  );
});

it('masks push capability URLs and authentication secrets in the administrator database browser', () => {
  directory = mkdtempSync(join(tmpdir(), 'mergeron-push-db-'));
  database = new DatabaseService(
    new ConfigService({ WEBUI_DB_PATH: join(directory, 'app.sqlite') }),
  );
  database.db
    .insert(people)
    .values({
      id: 'p',
      reference: 'p',
      name: 'Person',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(pushSubscriptions)
    .values({
      id: 'd',
      personId: 'p',
      endpoint: 'https://fcm.googleapis.com/secret-url',
      auth: 'secret-auth',
      p256dh: 'public-encryption-key',
      label: 'Phone',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const result = database.readTable('push_subscriptions', 1, 25);
  expect(result.rows[0]).toMatchObject({
    label: 'Phone',
    endpoint_secret: '••••••',
    auth_secret: '••••••',
  });
  expect(JSON.stringify(result)).not.toContain('secret-url');
  expect(JSON.stringify(result)).not.toContain('secret-auth');
});

it('reports the active SQLite path, storage size and safety settings', () => {
  directory = mkdtempSync(join(tmpdir(), 'codex-webui-database-'));
  const path = join(directory, 'application.sqlite');
  database = new DatabaseService(new ConfigService({ WEBUI_DB_PATH: path }));

  const status = database.getStatus();
  expect(status).toMatchObject({
    engine: 'SQLite',
    path,
    connected: true,
    readOnly: false,
    journalMode: 'WAL',
    foreignKeys: true,
  });
  expect(status.schemaVersion).toMatch(/^\d{4}_/);
  expect(status.appliedMigrationCount).toBeGreaterThan(0);
  expect(status.databaseSizeBytes).toBeGreaterThan(0);
  expect(status.totalSizeBytes).toBeGreaterThanOrEqual(
    status.databaseSizeBytes,
  );
});
