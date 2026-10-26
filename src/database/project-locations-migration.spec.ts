import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollbackProjectLocations } from '../../scripts/rollback-project-locations.mjs';
import { ConfigService } from '@nestjs/config';
import * as schema from './schema';
import { WorkspaceResourcesService } from '../projects/workspace-resources.service';

const migrations = readMigrationFiles({ migrationsFolder: 'drizzle' });
const journal = JSON.parse(
  readFileSync('drizzle/meta/_journal.json', 'utf8'),
) as {
  entries: Array<{ tag: string; idx: number; when: number }>;
};
const targetIndex = journal.entries.findIndex(
  (entry) => entry.tag === '0054_project_locations_connections',
);
// Keep rollback tests pinned to their migration even when later PRs add others.
const migrationDirectory = mkdtempSync(
  join(tmpdir(), 'mergeron-locations-migrations-'),
);
mkdirSync(join(migrationDirectory, 'meta'));
writeFileSync(
  join(migrationDirectory, 'meta/_journal.json'),
  JSON.stringify({
    ...journal,
    entries: journal.entries.slice(0, targetIndex + 1),
  }),
);
for (const entry of journal.entries.slice(0, targetIndex + 1))
  copyFileSync(
    `drizzle/${entry.tag}.sql`,
    join(migrationDirectory, `${entry.tag}.sql`),
  );
afterAll(() => rmSync(migrationDirectory, { recursive: true, force: true }));
let sqlite: Database.Database;
const rows = (table: string) =>
  sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
const apply = () =>
  migrate(drizzle(sqlite), { migrationsFolder: migrationDirectory });
const capabilities = '{"read":true,"write":false,"execute":false}';

function remote(id: string, protocol = 'sftp') {
  sqlite
    .prepare(
      `INSERT INTO project_workspace_resources
    (id, project_id, name, type, address, root_path, access_mode, capabilities,
     enabled, connection_state, last_checked_at, created_at, updated_at)
    VALUES (?, 'p', ?, ?, ?, '/exports/project', 'read_only', ?, 0, 'disabled', 7, 1, 2)`,
    )
    .run(id, id, protocol, `${protocol}://host.example.test`, capabilities);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  // An actual pre-0054 database, including Drizzle's applied-migration journal.
  sqlite.exec(
    'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)',
  );
  for (const migration of migrations.slice(0, targetIndex)) {
    for (const statement of migration.sql) sqlite.exec(statement);
    sqlite
      .prepare(
        'INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)',
      )
      .run(migration.hash, migration.folderMillis);
  }
  sqlite.exec(`INSERT INTO projects(id, name, workspace_path, created_at, updated_at) VALUES ('p','Project','/workspaces/p',1,2);
    INSERT INTO project_workspaces VALUES ('local','p','Principal','/workspaces/p',1,1,2);
    INSERT INTO project_workspaces VALUES ('copy','p','Copy','/external/copy',0,1,2);`);
  for (const protocol of ['git', 'ssh', 'sftp', 'ftp', 'ftps'])
    remote(protocol, protocol);
  sqlite.exec(`INSERT INTO project_workspace_resources
    (id,project_id,local_workspace_id,name,type,root_path,access_mode,capabilities,connection_state,created_at,updated_at)
    VALUES ('local','p','local','Principal','local','/','read_write','{}','local',1,2);
    INSERT INTO project_workspace_secrets VALUES ('sftp','unchanged-ciphertext','unchanged-iv','unchanged-tag',1,2);
    INSERT INTO project_workspace_copies VALUES ('working-copy','p','git','copy','Copy','main','revision','ready',NULL,1,2);`);
  sqlite.exec(`INSERT INTO project_agent_threads VALUES ('conversation','p','/external/copy',1,2);
    INSERT INTO project_active_folders VALUES ('agent','conversation','p','copy','documents',1,2);`);
});

afterEach(() => sqlite.close());

describe('locations/connections expand migration', () => {
  it('does not leave a partially migrated schema if backfill rejects an unsupported protocol', () => {
    remote('unsupported', 'unknown');
    const before = rows('project_workspace_resources');
    expect(apply).toThrow();
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='project_connections'",
        )
        .get(),
    ).toBeUndefined();
    expect(rows('project_workspace_resources')).toEqual(before);
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get(),
    ).toEqual({ n: targetIndex });
  });

  it('keeps an existing encrypted credential usable with the same key after migration', () => {
    const resources = new WorkspaceResourcesService(
      drizzle(sqlite, { schema }),
      new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'existing-key' }),
    );
    const resource = resources.create('p', {
      type: 'ssh',
      name: 'Existing',
      address: 'ssh://host.example.test',
      secret: { username: 'existing-user', password: 'existing-test-password' },
    });
    const encrypted = sqlite
      .prepare('SELECT * FROM project_workspace_secrets WHERE resource_id=?')
      .get(resource.id);
    apply();
    expect(resources.resolveForTransfer('p', resource.id).secret).toEqual({
      username: 'existing-user',
      password: 'existing-test-password',
    });
    expect(
      sqlite
        .prepare('SELECT * FROM project_workspace_secrets WHERE resource_id=?')
        .get(resource.id),
    ).toEqual(encrypted);
  });

  it('rolls back the legacy write if a synchronized location update fails', () => {
    apply();
    sqlite.exec(`CREATE TRIGGER fail_location BEFORE UPDATE ON project_locations
      WHEN NEW.id='remote:sftp' BEGIN SELECT RAISE(ABORT,'test failure'); END;`);
    expect(() =>
      sqlite.exec(
        "UPDATE project_workspace_resources SET name='Must roll back', root_path='/blocked' WHERE id='sftp'",
      ),
    ).toThrow('test failure');
    expect(
      sqlite
        .prepare(
          "SELECT name, root_path FROM project_workspace_resources WHERE id='sftp'",
        )
        .get(),
    ).toEqual({ name: 'sftp', root_path: '/exports/project' });
    expect(
      sqlite
        .prepare("SELECT name FROM project_connections WHERE id='sftp'")
        .get(),
    ).toEqual({ name: 'sftp' });
  });

  it('backfills every protocol and local location without changing legacy records or encrypted secrets', () => {
    const associations = () => [
      sqlite.prepare('SELECT * FROM project_agent_threads').all(),
      sqlite.prepare('SELECT * FROM project_active_folders').all(),
    ];
    const originalAssociations = associations();
    const before = [
      'projects',
      'project_workspaces',
      'project_workspace_resources',
      'project_workspace_copies',
    ].map(rows);
    const secret = sqlite
      .prepare('SELECT * FROM project_workspace_secrets')
      .all();
    apply();
    expect(associations()).toEqual(originalAssociations);
    expect(
      [
        'projects',
        'project_workspaces',
        'project_workspace_resources',
        'project_workspace_copies',
      ].map(rows),
    ).toEqual(before);
    expect(
      sqlite.prepare('SELECT * FROM project_workspace_secrets').all(),
    ).toEqual(secret);
    expect(rows('project_connections')).toHaveLength(5);
    expect(rows('project_locations')).toHaveLength(7);
    expect(
      sqlite
        .prepare(
          "SELECT kind, path FROM project_locations WHERE id='local:local'",
        )
        .get(),
    ).toEqual({ kind: 'managed_local', path: '/workspaces/p' });
    expect(
      sqlite
        .prepare(
          "SELECT connection_id, path, access_mode, capabilities FROM project_locations WHERE id='remote:sftp'",
        )
        .get(),
    ).toEqual({
      connection_id: 'sftp',
      path: '/exports/project',
      access_mode: 'read_only',
      capabilities,
    });
    expect(
      sqlite
        .prepare(
          "SELECT enabled, connection_state, last_checked_at FROM project_connections WHERE id='sftp'",
        )
        .get(),
    ).toEqual({ enabled: 0, connection_state: 'disabled', last_checked_at: 7 });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    const normalized = rows('project_locations');
    apply();
    expect(rows('project_locations')).toEqual(normalized);
  });

  it('tracks legacy insert/update/detach atomically, including local folders without compatibility resources', () => {
    apply();
    remote('new');
    sqlite.exec(`UPDATE project_workspace_resources SET name='Renamed', root_path='/new', address='sftp://new.example.test', enabled=1, connection_state='untested', access_mode='read_write', updated_at=9 WHERE id='new';
      UPDATE project_workspaces SET name='Renamed local', path='/same/files', updated_at=10 WHERE id='copy';`);
    expect(
      sqlite
        .prepare(
          "SELECT name, address, enabled FROM project_connections WHERE id='new'",
        )
        .get(),
    ).toEqual({
      name: 'Renamed',
      address: 'sftp://new.example.test',
      enabled: 1,
    });
    expect(
      sqlite
        .prepare(
          "SELECT path, access_mode FROM project_locations WHERE id='remote:new'",
        )
        .get(),
    ).toEqual({ path: '/new', access_mode: 'read_write' });
    expect(
      sqlite
        .prepare(
          "SELECT name, path FROM project_locations WHERE id='local:copy'",
        )
        .get(),
    ).toEqual({ name: 'Renamed local', path: '/same/files' });
    sqlite.exec("DELETE FROM project_workspace_resources WHERE id='git'");
    expect(
      sqlite.prepare("SELECT id FROM project_connections WHERE id='git'").get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT id FROM project_locations WHERE id='remote:git'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT id FROM project_locations WHERE id='local:copy'")
        .get(),
    ).toBeDefined();
    expect(rows('project_workspace_copies')).toHaveLength(1);
    sqlite.exec("DELETE FROM project_workspaces WHERE id='copy'");
    expect(
      sqlite
        .prepare("SELECT id FROM project_locations WHERE id='local:copy'")
        .get(),
    ).toBeUndefined();
    sqlite.exec("DELETE FROM projects WHERE id='p'");
    expect(rows('project_connections')).toEqual([]);
    expect(rows('project_locations')).toEqual([]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('supports several roots per connection but rejects cross-project associations', () => {
    apply();
    sqlite.exec(
      "INSERT INTO projects(id,name,workspace_path,created_at,updated_at) VALUES ('other','Other','/other',1,1)",
    );
    const insert = sqlite.prepare(`INSERT INTO project_locations
      (id,project_id,name,kind,path,connection_id,access_mode,capabilities,created_at,updated_at)
      VALUES (?,?,'Other root','remote','/another','sftp','read_only','{}',1,2)`);
    expect(() => insert.run('second-root', 'p')).not.toThrow();
    expect(() => insert.run('forbidden', 'other')).toThrow(/FOREIGN KEY/);
    expect(() =>
      sqlite.exec(
        "UPDATE project_locations SET project_id='other' WHERE id='local:copy'",
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() => rollbackProjectLocations(sqlite)).toThrow(/non-legacy/);
    expect(rows('project_locations')).toHaveLength(8);
  });

  it('rolls back only this migration, preserves legacy writes and reapplies with stable identifiers', () => {
    apply();
    const secret = sqlite
      .prepare('SELECT * FROM project_workspace_secrets')
      .all();
    sqlite.exec(
      "UPDATE project_workspace_resources SET root_path='/latest' WHERE id='sftp'",
    );
    const before = rows('project_locations');
    rollbackProjectLocations(sqlite);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='project_locations'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare(
          "SELECT root_path FROM project_workspace_resources WHERE id='sftp'",
        )
        .get(),
    ).toEqual({ root_path: '/latest' });
    expect(
      sqlite.prepare('SELECT * FROM project_workspace_secrets').all(),
    ).toEqual(secret);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    apply();
    expect(rows('project_locations')).toEqual(before);
    // Future migrations must never be silently removed by this rollback tool.
    sqlite
      .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
      .run('future', Date.now() + 100000);
    expect(() => rollbackProjectLocations(sqlite)).toThrow(
      /latest applied migration/,
    );
    expect(rows('project_locations')).toEqual(before);
  });
});
