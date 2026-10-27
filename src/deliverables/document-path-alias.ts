import { sql } from 'drizzle-orm';
import * as path from 'node:path';
import type { AppDatabase } from '../database/database.constants';
import { projectDeliverableDocuments as documents } from '../database/schema';

/** Old managed links resolve to the current document; history itself is never rewritten. */
export function documentPathAlias(
  db: AppDatabase | undefined,
  input: string,
): string {
  if (!db || !input || !path.isAbsolute(input)) return input;
  const matches = db
    .select({ path: documents.sourcePath })
    .from(documents)
    .where(
      sql`EXISTS (SELECT 1 FROM json_each(${documents.previousSourcePaths}) WHERE value = ${path.resolve(input)})`,
    )
    .all();
  if (matches.length > 1) throw new Error('Ambiguous retained document path');
  return matches[0]?.path ?? input;
}
