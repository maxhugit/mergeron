import type { AppDatabase } from '../database/database.constants';

/** Startup migrations share one filesystem/metadata boundary per application DB. */
const pending = new WeakMap<AppDatabase, Promise<unknown>>();
export async function serializeProjectLayout<T>(
  db: AppDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pending.get(db) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pending.set(db, current);
  try {
    return await current;
  } finally {
    if (pending.get(db) === current) pending.delete(db);
  }
}
