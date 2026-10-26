/** Offline, narrow rollback of migration 0054. Never touches files or secrets. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tag = '0054_project_locations_connections';
const migration = readFileSync(
  new URL(`../drizzle/${tag}.sql`, import.meta.url),
);
const hash = createHash('sha256').update(migration).digest('hex');
const journal = JSON.parse(
  readFileSync(
    new URL('../drizzle/meta/_journal.json', import.meta.url),
    'utf8',
  ),
);
const timestamp = journal.entries.find((entry) => entry.tag === tag).when;

export function rollbackProjectLocations(sqlite) {
  // The caller must stop every writer and back up the database first.
  sqlite.transaction(() => {
    const latest = sqlite
      .prepare(
        'SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get();
    if (latest?.hash !== hash || latest.created_at !== timestamp)
      throw new Error(
        'Rollback refused: migration 0054 must be the latest applied migration',
      );
    const additional = sqlite
      .prepare(
        `SELECT count(*) AS count FROM project_locations
      WHERE (kind = 'remote' AND (legacy_resource_id IS NULL OR id <> 'remote:' || legacy_resource_id))
         OR (kind <> 'remote' AND id <> 'local:' || local_workspace_id)`,
      )
      .get();
    if (additional.count)
      throw new Error(
        'Rollback refused: non-legacy locations require a separate migration',
      );
    for (const trigger of [
      'workspace_insert',
      'workspace_update',
      'resource_insert',
      'resource_update',
    ])
      sqlite.exec(`DROP TRIGGER project_locations_${trigger}`);
    sqlite.exec(
      'DROP TABLE project_locations; DROP TABLE project_connections; DROP INDEX idx_project_workspaces_id_project;',
    );
    sqlite
      .prepare('DELETE FROM __drizzle_migrations WHERE id = ?')
      .run(latest.id);
  })();
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [databasePath, confirmation] = process.argv.slice(2);
  if (!databasePath || confirmation !== '--backup-confirmed')
    throw new Error(
      'Stop Mergeron and back up SQLite, then run: node scripts/rollback-project-locations.mjs DATABASE --backup-confirmed',
    );
  const sqlite = new Database(databasePath, { fileMustExist: true });
  try {
    sqlite.pragma('foreign_keys = ON');
    rollbackProjectLocations(sqlite);
    console.log(
      'Migration 0054 reverted. Start an older application version to avoid reapplying it.',
    );
  } finally {
    sqlite.close();
  }
}
