import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { expect, it } from 'vitest';

it('upgrades an existing installation without changing projects, people, conversations or settings', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    const migrations = readMigrationFiles({ migrationsFolder: 'drizzle' });
    const target = migrations.findIndex((m) =>
      m.sql.some((statement) =>
        statement.includes('CREATE TABLE `agent_monitors`'),
      ),
    );
    expect(target).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, target))
      for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec(
      "INSERT INTO projects (id, name, workspace_path, created_at, updated_at) VALUES ('p', 'Existing project', '/project', 1, 2)",
    );
    sqlite.exec(
      "INSERT INTO people (id, reference, name, role, created_at, updated_at) VALUES ('a', 'a', 'Administrator', 'administrator', 1, 2)",
    );
    sqlite.exec(
      "INSERT INTO project_agent_threads VALUES ('t', 'p', '/project', 1, 2)",
    );
    const tables = ['projects', 'people', 'project_agent_threads', 'settings'];
    const before = tables.map((table) =>
      sqlite.prepare(`SELECT * FROM ${table}`).all(),
    );
    // The later archival migration adds nullable metadata without rewriting
    // any existing conversation data or attributing old archives to a person.
    before[2] = before[2].map((row) => ({
      ...(row as Record<string, unknown>),
      archived_at: null,
      archived_by_person_id: null,
      archived_by_name: null,
      archived_by_type: null,
    }));
    for (const migration of migrations.slice(target))
      for (const statement of migration.sql) sqlite.exec(statement);
    expect(
      tables.map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
    expect(sqlite.prepare('SELECT * FROM agent_monitors').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM agent_monitor_runs').all()).toEqual(
      [],
    );
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    sqlite.close();
  }
});
