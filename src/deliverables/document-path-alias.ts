import { sql } from 'drizzle-orm';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { eq } from 'drizzle-orm';
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

/** Office callbacks may retain a logical filesystem alias (for example /var on macOS). */
export function registeredDocumentPath(db: AppDatabase, input: string): string {
  const mapped = documentPathAlias(db, input);
  if (
    db
      .select({ path: documents.sourcePath })
      .from(documents)
      .where(eq(documents.sourcePath, mapped))
      .get()
  )
    return mapped;
  let canonical: string;
  try {
    canonical = realpathSync(mapped);
  } catch {
    return mapped;
  }
  if (
    db
      .select({ path: documents.sourcePath })
      .from(documents)
      .where(eq(documents.sourcePath, canonical))
      .get()
  )
    return canonical;
  for (const document of db
    .select({ path: documents.sourcePath })
    .from(documents)
    .all()) {
    try {
      if (realpathSync(document.path) === canonical) return document.path;
    } catch {
      /* Missing sources are handled by protection reconciliation. */
    }
  }
  return mapped;
}
