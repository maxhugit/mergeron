import * as fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import {
  projects,
  projectResources,
  projectDeliverables,
  projectDeliverableDocuments as documents,
} from '../database/schema';

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Validate every parent, not just realpath: an old projection must never escape via a link. */
async function regularPath(root: string, file: string) {
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Document escaped its project');
  let current = root;
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (
      stat.isSymbolicLink() ||
      (current !== file && !stat.isDirectory()) ||
      (current === file && (!stat.isFile() || stat.nlink !== 1))
    )
      throw new Error(
        'Document migration refuses symbolic links and aliased files',
      );
  }
  return fs.stat(file);
}

function managedPath(root: string, deliverableId: string, source: string) {
  const published = path.join(root, 'livrables', deliverableId, 'published');
  const relative = path.relative(published, source);
  const parts = relative.split(path.sep);
  return (
    parts.length === 2 &&
    parts.every((part) => part && part !== '.' && part !== '..') &&
    !path.isAbsolute(relative)
  );
}

async function retireProjection(
  root: string,
  former: string,
  target: string,
  hash: string,
) {
  try {
    await fs.lstat(former);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const before = await regularPath(root, former);
  await regularPath(root, target);
  if ((await digest(former)) !== hash || (await digest(target)) !== hash)
    throw new Error(
      'Old projection or destination changed; retained without deletion',
    );
  const after = await regularPath(root, former);
  if (
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size
  )
    throw new Error('Old projection changed; retained without deletion');
  await fs.unlink(former);
  for (const directory of [
    path.dirname(former),
    path.dirname(path.dirname(former)),
  ])
    await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code ?? ''))
        throw error;
    });
}

/** Startup-only relocation. Each document is independently restartable; no snapshots are touched. */
export async function migrateDeliverableDocumentRoots(
  db: AppDatabase,
  warn: (message: string) => void,
) {
  const rows = db
    .select({ document: documents, project: projects })
    .from(documents)
    .innerJoin(
      projectDeliverables,
      eq(documents.deliverableId, projectDeliverables.id),
    )
    .innerJoin(
      projectResources,
      eq(projectDeliverables.resourceId, projectResources.id),
    )
    .innerJoin(projects, eq(projectResources.projectId, projects.id))
    .all();
  const result = { migrated: 0, blocked: 0 };
  for (const { document, project } of rows) {
    if (project.workspaceLayoutVersion < 1) continue;
    const legacy = managedPath(
      project.workspacePath,
      document.deliverableId,
      document.sourcePath,
    );
    const retired = document.previousSourcePaths.filter((former) =>
      managedPath(project.workspacePath, document.deliverableId, former),
    );
    if (!legacy && retired.length === 0) continue;
    try {
      const root = project.workspacePath;
      if (
        !document.name ||
        path.basename(document.name) !== document.name ||
        ['.', '..'].includes(document.name)
      )
        throw new Error('Invalid document name');
      const target = path.join(
        root,
        'livrables',
        document.deliverableId,
        document.name,
      );
      if (!legacy) {
        if (document.sourcePath !== target) continue;
        // Resume after a crash between committing the reference and removing the old file.
        await regularPath(root, target);
        const hash = await digest(target);
        for (const former of retired)
          await retireProjection(root, former, target, hash);
        continue;
      }
      if (
        rows.some(
          (row) =>
            row.document.id !== document.id &&
            (row.document.sourcePath === target ||
              (row.document.deliverableId === document.deliverableId &&
                row.document.name === document.name)),
        )
      )
        throw new Error(
          'Another document reserves this name; choose a unique name before migrating',
        );
      const before = await regularPath(root, document.sourcePath);
      const hash = await digest(document.sourcePath);
      // Parent validation includes the future destination's directory.
      await regularPath(root, document.sourcePath);
      try {
        await fs.copyFile(document.sourcePath, target, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A previous interrupted attempt may have copied the file. Never overwrite it.
        await regularPath(root, target);
        if ((await digest(target)) !== hash)
          throw new Error(
            'Destination already exists with different content; no file was overwritten',
          );
      }
      await regularPath(root, target);
      const after = await regularPath(root, document.sourcePath);
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        (await digest(document.sourcePath)) !== hash ||
        (await digest(target)) !== hash
      )
        throw new Error(
          'Document changed during relocation; original and history were preserved',
        );
      const changed = db
        .update(documents)
        .set({
          sourcePath: target,
          previousSourcePaths: [
            ...new Set([...document.previousSourcePaths, document.sourcePath]),
          ],
        })
        .where(
          and(
            eq(documents.id, document.id),
            eq(documents.sourcePath, document.sourcePath),
            eq(documents.currentVersionNumber, document.currentVersionNumber),
          ),
        )
        .run();
      if (changed.changes !== 1)
        throw new Error('Document metadata changed during relocation');
      result.migrated++;
      // Removal is confined to the verified former projection, never its siblings or history.
      await retireProjection(root, document.sourcePath, target, hash);
    } catch (error) {
      result.blocked++;
      warn(
        `Retained document ${document.id}: root migration needs attention: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  return result;
}
