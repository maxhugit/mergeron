import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { AppDatabase } from '../database/database.constants';
import { projects } from '../database/schema';
import {
  projectSystemPath,
  PROJECT_SYSTEM_DIRECTORY,
  LEGACY_PROJECT_SYSTEM_DIRECTORY,
} from './workspace-structure';

/** Stable redirects for old links; no filesystem symlink grants access to system data. */
export function projectSystemAlias(db: AppDatabase | undefined, input: string) {
  if (!db || !input || !path.isAbsolute(input)) return input;
  const value = path.resolve(input);
  for (const project of db.select().from(projects).all()) {
    if (project.workspaceLayoutVersion < 3) continue;
    for (const [name, suffix] of [
      [PROJECT_SYSTEM_DIRECTORY, ''],
      [LEGACY_PROJECT_SYSTEM_DIRECTORY, ''],
      ['.agent-document-drafts', 'draft-archive'],
      ['livrables/.version-staging', 'staging-archive'],
    ]) {
      const old = path.join(project.workspacePath, name);
      // A fresh, short-lived publication stage is not an archived legacy file.
      if (name === 'livrables/.version-staging' && existsSync(value)) continue;
      if (
        name === PROJECT_SYSTEM_DIRECTORY ||
        name === LEGACY_PROJECT_SYSTEM_DIRECTORY
      ) {
        for (const [sub, category] of [
          ['imported-workspaces', 'sources'],
          ['imported-attachments', 'documents'],
        ]) {
          const business = path.join(old, sub);
          if (value === business || value.startsWith(business + path.sep))
            return path.join(
              project.workspacePath,
              category,
              sub,
              path.relative(business, value),
            );
        }
      }
      if (value === old || value.startsWith(old + path.sep))
        return path.join(
          projectSystemPath(project.workspacePath),
          suffix,
          path.relative(old, value),
        );
    }
  }
  return input;
}
