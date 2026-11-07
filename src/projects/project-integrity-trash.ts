/** Reversible removal of explicitly confirmed, unreferenced managed projections. */
import { ConflictException } from '@nestjs/common';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import * as schema from '../database/schema';
import { projectSystemAlias } from './project-system-paths';
import type { IntegrityIssue } from './project-integrity.service';

const inside = (root: string, value: string) =>
  value === root || value.startsWith(root + path.sep);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const kinds = new Set([
  'unregistered-document',
  'unregistered-deliverable-directory',
  'unregistered-copy',
]);
const absent = async (p: string) =>
  fs.lstat(p).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

type Actor = { personId: string | null; name: string };
export interface IntegrityTrashEntry {
  id: string;
  name: string;
  originalPath: string;
  kind: string;
  createdAt: number;
  actorName: string;
}

/** All persistent path references, including other projects, deleted documents and history. */
export function integrityProtectedPaths(db: AppDatabase): string[] | null {
  const tables = [
    schema.projectResources,
    schema.projectDeliverables,
    schema.projectDeliverableDocuments,
    schema.projectDeliverableDocumentVersions,
    schema.projectWorkspaceCopies,
    schema.projectWorkspaces,
    schema.projectWorkspaceResources,
    schema.projectLocations,
    schema.projectAgentThreads,
    schema.projectTasks,
    schema.simpleChatThreads,
    schema.settings,
  ];
  const paths: string[] = [];
  let values = 0;
  const walk = (value: unknown, depth: number) => {
    if (++values > 100000 || depth > 16)
      throw new Error('Reference inventory limited');
    if (typeof value === 'string') {
      if (path.isAbsolute(value))
        paths.push(
          path.resolve(value),
          path.resolve(projectSystemAlias(db, value)),
        );
      else if (
        (value.startsWith('{') || value.startsWith('[')) &&
        value.length < 1024 * 1024
      ) {
        try {
          walk(JSON.parse(value), depth + 1);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'Reference inventory limited'
          )
            throw error;
        }
      }
    } else if (Array.isArray(value))
      value.forEach((item) => walk(item, depth + 1));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((item) => walk(item, depth + 1));
  };
  try {
    for (const table of tables) walk(db.select().from(table).all(), 0);
    const workspaces = db.select().from(schema.projectWorkspaces).all();
    const locations = db.select().from(schema.projectLocations).all();
    for (const folder of db.select().from(schema.projectActiveFolders).all()) {
      const base =
        workspaces.find(
          (item) =>
            item.id === folder.resourceId ||
            `local:${item.id}` === folder.resourceId,
        )?.path ??
        locations.find(
          (item) =>
            item.id === folder.resourceId ||
            item.legacyResourceId === folder.resourceId,
        )?.path;
      if (base) paths.push(path.resolve(base, folder.relativePath));
    }
    return [...new Set(paths)];
  } catch {
    return null;
  }
}

/** The report does not classify free user folders, technical staging or unsafe trees as disposable. */
export async function canTrashIntegrityIssue(
  root: string,
  issue: IntegrityIssue,
  protectedPaths: string[] | null,
  facts?: unknown[],
  budget = { remaining: 5000 },
): Promise<boolean> {
  if (
    process.platform !== 'linux' ||
    !kinds.has(issue.kind) ||
    !protectedPaths ||
    path.resolve(issue.path) !== issue.path
  )
    return false;
  const system = path.join(root, '.mergeron-system');
  const base =
    issue.kind === 'unregistered-copy'
      ? path.join(system, 'sources')
      : path.join(system, 'livrables');
  const relative = path.relative(base, issue.path);
  if (
    !relative ||
    !inside(base, issue.path) ||
    relative.split(path.sep).some((part) => part.startsWith('.')) ||
    protectedPaths.some((value) => inside(issue.path, value))
  )
    return false;
  let visited = 0;
  const safe = async (target: string, depth: number): Promise<boolean> => {
    if (++visited > 5000 || --budget.remaining < 0 || depth > 16) return false;
    const info = await fs.lstat(target);
    facts?.push([
      'trash-entry',
      target,
      info.dev,
      info.ino,
      info.mode,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ]);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink > 1)
    )
      return false;
    if (info.isFile()) return true;
    const names: string[] = [];
    for await (const entry of await fs.opendir(target)) {
      if (names.length > budget.remaining) return false;
      names.push(entry.name);
    }
    names.sort();
    for (const name of names)
      if (!(await safe(path.join(target, name), depth + 1))) return false;
    return true;
  };
  try {
    if ((await fs.realpath(issue.path)) !== issue.path) return false;
    return await safe(issue.path, 0);
  } catch {
    return false;
  }
}

/** Descriptor-relative directories: ancestors cannot redirect a move through a symlink. */
async function anchoredDirectory(target: string): Promise<fs.FileHandle> {
  if (process.platform !== 'linux' || path.resolve(target) !== target)
    throw new ConflictException('Safe trash unavailable');
  let handle = await fs.open(
    '/',
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const component of target.split('/').filter(Boolean)) {
      const next = await fs.open(
        `/proc/self/fd/${handle.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function trashDirectory(
  root: string,
  create: boolean,
): Promise<fs.FileHandle> {
  let parent = await anchoredDirectory(path.join(root, '.mergeron-system'));
  try {
    for (const name of ['operations', 'integrity-trash']) {
      const target = `/proc/self/fd/${parent.fd}/${name}`;
      if (create)
        await fs
          .mkdir(target, { mode: 0o700 })
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'EEXIST') throw e;
          });
      const next = await fs.open(
        target,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await parent.close();
      parent = next;
    }
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}

function history(db: AppDatabase, projectId: string) {
  return db
    .select()
    .from(schema.projectActivity)
    .where(eq(schema.projectActivity.projectId, projectId))
    .all()
    .filter((row) => row.action === 'integrity.trash');
}

export async function listIntegrityTrash(
  db: AppDatabase,
  projectId: string,
  root: string,
): Promise<IntegrityTrashEntry[]> {
  if (process.platform !== 'linux') return [];
  let folder: fs.FileHandle;
  try {
    folder = await trashDirectory(root, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConflictException('Trash directory unavailable');
  }
  try {
    const entries: IntegrityTrashEntry[] = [];
    for (const row of history(db, projectId)) {
      const d = row.details;
      if (
        !uuid.test(row.id) ||
        typeof d.originalPath !== 'string' ||
        !inside(root, d.originalPath) ||
        !kinds.has(String(d.kind))
      )
        continue;
      const info = await absent(`/proc/self/fd/${folder.fd}/${row.id}`);
      if (
        !info ||
        info.isSymbolicLink() ||
        (!info.isFile() && !info.isDirectory())
      )
        continue;
      entries.push({
        id: row.id,
        name: path.basename(d.originalPath),
        originalPath: d.originalPath,
        kind: String(d.kind),
        createdAt: row.createdAt,
        actorName: row.actorName,
      });
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    await folder.close();
  }
}

export async function putIntegrityTrash(
  db: AppDatabase,
  projectId: string,
  root: string,
  issue: IntegrityIssue,
  actor: Actor,
) {
  const source = await anchoredDirectory(path.dirname(issue.path));
  const trash = await trashDirectory(root, true).catch(async (error) => {
    await source.close();
    throw error;
  });
  const id = randomUUID();
  try {
    const from = `/proc/self/fd/${source.fd}/${path.basename(issue.path)}`;
    const info = await fs.lstat(from);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new ConflictException('Source changed');
    // Journal before moving: even a database failure after rename leaves a recoverable entry.
    db.insert(schema.projectActivity)
      .values({
        id,
        projectId,
        action: 'integrity.trash',
        entityType: 'project',
        entityId: projectId,
        label: issue.kind,
        details: {
          originalPath: issue.path,
          kind: issue.kind,
          device: info.dev,
          inode: info.ino,
          state: 'requested',
        },
        actorPersonId: actor.personId,
        actorName: actor.name,
        createdAt: Date.now(),
      })
      .run();
    await fs.rename(from, `/proc/self/fd/${trash.fd}/${id}`);
    db.update(schema.projectActivity)
      .set({
        details: {
          originalPath: issue.path,
          kind: issue.kind,
          device: info.dev,
          inode: info.ino,
          state: 'stored',
        },
      })
      .where(eq(schema.projectActivity.id, id))
      .run();
  } finally {
    await source.close();
    await trash.close();
  }
}

/** Recover into free Dossiers under a fresh UUID name: never overwrite or reattach a document. */
export async function recoverIntegrityTrash(
  db: AppDatabase,
  projectId: string,
  root: string,
  id: string,
  actor: Actor,
) {
  const entry = (await listIntegrityTrash(db, projectId, root)).find(
    (item) => item.id === id,
  );
  if (!entry) throw new ConflictException('Trash entry unavailable');
  const source = await trashDirectory(root, false),
    destination = await anchoredDirectory(path.join(root, 'dossiers')).catch(
      async (error) => {
        await source.close();
        throw error;
      },
    );
  try {
    const parsed = path.parse(entry.name),
      recoveryId = randomUUID();
    const name = `${[...parsed.name].slice(0, 24).join('')}.recovered-${recoveryId}${[...parsed.ext].slice(0, 24).join('')}`;
    const target = path.join(root, 'dossiers', name);
    const from = `/proc/self/fd/${source.fd}/${id}`,
      to = `/proc/self/fd/${destination.fd}/${name}`;
    if (await absent(to))
      throw new ConflictException('Recovery destination exists');
    db.insert(schema.projectActivity)
      .values({
        id: recoveryId,
        projectId,
        action: 'integrity.recover',
        entityType: 'project',
        entityId: projectId,
        label: entry.name,
        details: {
          trashId: id,
          originalPath: entry.originalPath,
          path: target,
          state: 'requested',
        },
        actorPersonId: actor.personId,
        actorName: actor.name,
        createdAt: Date.now(),
      })
      .run();
    await fs.rename(from, to);
    db.update(schema.projectActivity)
      .set({
        details: {
          trashId: id,
          originalPath: entry.originalPath,
          path: target,
          state: 'recovered',
        },
      })
      .where(eq(schema.projectActivity.id, recoveryId))
      .run();
    return { path: target };
  } finally {
    await source.close();
    await destination.close();
  }
}
