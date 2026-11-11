import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { expect, it } from 'vitest';

it('adds per-agent source selection without changing existing projects or preview rows', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    const migrations = readMigrationFiles({ migrationsFolder: 'drizzle' });
    for (const migration of migrations.slice(0, -1))
      for (const sql of migration.sql) sqlite.exec(sql);
    sqlite.exec(
      "INSERT INTO projects (id,name,workspace_path,created_at,updated_at) VALUES ('p','Existing','/workspaces/p',1,1)",
    );
    sqlite.exec(
      "INSERT INTO agent_previews (agent_id,thread_id,project_id,preview_id,run_id,request_id,source_path,profile_revision,state,created_at,updated_at) VALUES ('a','a','p','preview','run','request','/workspaces/p','policy','stopped',1,1)",
    );
    const original = sqlite.prepare('SELECT * FROM agent_previews').all();
    for (const sql of migrations.at(-1)!.sql) sqlite.exec(sql);
    expect(sqlite.prepare('SELECT * FROM agent_previews').all()).toEqual(
      original.map((row) => ({ ...(row as object), source: null })),
    );
    expect(sqlite.prepare('SELECT * FROM agent_preview_sources').all()).toEqual(
      [],
    );
    const insert = sqlite.prepare(
      'INSERT INTO agent_preview_sources (agent_id,project_id,source,revision,updated_at) VALUES (?, ?, ?, ?, 1)',
    );
    insert.run(
      'a',
      'p',
      JSON.stringify({
        type: 'git_copy',
        connectionId: 'connection',
        copyId: 'copy',
        subdirectory: '.',
      }),
      'rev',
    );
    insert.run('b', 'p', JSON.stringify({ type: 'agent_reference' }), 'other');
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM agent_preview_sources')
        .get(),
    ).toEqual({ count: 2 });
    sqlite.exec("DELETE FROM projects WHERE id='p'");
    expect(sqlite.prepare('SELECT * FROM agent_preview_sources').all()).toEqual(
      [],
    );
  } finally {
    sqlite.close();
  }
});
