/** Native SQLite, no external accounts: fresh and upgrade paths are CI-safe. */
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { expect, it } from 'vitest';
it('adds agent recipes without changing existing project policies or instances', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    const migrations = readMigrationFiles({ migrationsFolder: 'drizzle' });
    const target = migrations.findIndex((m) =>
      m.sql.some((sql) => sql.includes('CREATE TABLE `agent_preview_recipes`')),
    );
    expect(target).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, target))
      for (const sql of migration.sql) sqlite.exec(sql);
    sqlite
      .prepare(
        'INSERT INTO projects (id, name, workspace_path, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
      )
      .run('p', 'Project', '/workspaces/project');
    sqlite
      .prepare(
        'INSERT INTO project_preview_profiles (project_id, encrypted_profile, revision, updated_at) VALUES (?, ?, ?, 1)',
      )
      .run('p', 'existing-encrypted-policy', 'policy-revision');
    sqlite
      .prepare(
        'INSERT INTO agent_previews (agent_id, thread_id, project_id, preview_id, run_id, request_id, source_path, profile_revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)',
      )
      .run(
        'a',
        't',
        'p',
        'preview',
        'run',
        'start',
        '/workspaces/source',
        'policy-revision',
        'running',
      );
    for (const migration of migrations.slice(target))
      for (const sql of migration.sql) sqlite.exec(sql);
    expect(
      sqlite
        .prepare('SELECT encrypted_profile FROM project_preview_profiles')
        .get(),
    ).toEqual({ encrypted_profile: 'existing-encrypted-policy' });
    expect(sqlite.prepare('SELECT state FROM agent_previews').get()).toEqual({
      state: 'running',
    });
    const insert = sqlite.prepare(
      'INSERT INTO agent_preview_recipes (agent_id, project_id, encrypted_recipe, revision, policy_revision, request_id, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    );
    insert.run(
      'a',
      'p',
      'cipher-a',
      'recipe-a',
      'policy-revision',
      'request',
      'hash-a',
    );
    insert.run(
      'b',
      'p',
      'cipher-b',
      'recipe-b',
      'policy-revision',
      'request',
      'hash-b',
    );
    expect(() =>
      insert.run(
        'a',
        'p',
        'cipher-c',
        'recipe-c',
        'policy-revision',
        'request',
        'hash-c',
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert.run(
        'c',
        'other-project',
        'cipher-c',
        'recipe-c',
        'policy-revision',
        'request',
        'hash-c',
      ),
    ).toThrow(/FOREIGN KEY/);
  } finally {
    sqlite.close();
  }
});
