import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('upgrades an existing installation without inventing archival metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mergeron-archive-migration-'));
  const sqlite = new Database(':memory:');
  try {
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { tag: string }[] };
    mkdirSync(join(directory, 'meta'));
    const entries = journal.entries.filter(
      (entry) => entry.tag !== '0065_thread_archival',
    );
    writeFileSync(
      join(directory, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    for (const entry of entries)
      copyFileSync(
        `drizzle/${entry.tag}.sql`,
        join(directory, `${entry.tag}.sql`),
      );
    migrate(drizzle(sqlite), { migrationsFolder: directory });
    sqlite
      .prepare(
        'INSERT INTO projects (id,name,workspace_path,created_at,updated_at) VALUES (?,?,?,?,?)',
      )
      .run('p', 'P', '/p', 1, 1);
    sqlite
      .prepare(
        'INSERT INTO project_agent_threads (thread_id,project_id,workspace_path,created_at,updated_at) VALUES (?,?,?,?,?)',
      )
      .run('legacy', 'p', '/p', 1, 2);
    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
    expect(
      sqlite
        .prepare(
          'SELECT archived_at,archived_by_person_id,archived_by_name,archived_by_type FROM project_agent_threads WHERE thread_id = ?',
        )
        .get('legacy'),
    ).toEqual({
      archived_at: null,
      archived_by_person_id: null,
      archived_by_name: null,
      archived_by_type: null,
    });
    expect(
      sqlite
        .prepare(
          'SELECT workspace_path,created_at,updated_at FROM project_agent_threads WHERE thread_id = ?',
        )
        .get('legacy'),
    ).toEqual({ workspace_path: '/p', created_at: 1, updated_at: 2 });
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
