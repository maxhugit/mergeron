/** In-memory SQLite fixture, without native addons or external account access. */
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import * as schema from '../database/schema';
export function mediaTestDatabase(extra = '') {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of [
    '0066_transcription_jobs',
    '0067_media_audio_extraction',
  ])
    sqlite.exec(
      readFileSync('drizzle/' + migration + '.sql', 'utf8').replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    );
  if (extra) sqlite.exec(extra);
  const adapter = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      return {
        raw(this: object) {
          statement.setReturnArrays(true);
          return this;
        },
        all(...params: unknown[]) {
          return statement.all(...(params as never[]));
        },
        get(...params: unknown[]) {
          return statement.get(...(params as never[]));
        },
        run(...params: unknown[]) {
          return statement.run(...(params as never[]));
        },
      };
    },
  };
  return { sqlite, db: drizzle(adapter as never, { schema }) };
}
