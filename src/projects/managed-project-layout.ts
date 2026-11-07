import { ConflictException } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { and, eq, getTableColumns } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import * as schema from '../database/schema';
import {
  WORKSPACE_LAYOUT_VERSION,
  projectDraftPath,
  projectSystemPath,
  projectSourcesPath,
  PROJECT_WORKSPACE_INSTRUCTIONS,
  SEPARATE_PROJECT_WORKSPACE_INSTRUCTIONS,
} from './workspace-structure';

type Move = { from: string; to: string };
type Journal = {
  projectId: string;
  version: 4;
  moves: Move[];
  completed: number;
};
const exists = (p: string) =>
  fs.lstat(p).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  });

/** Relocate only durable conversation cwd and explicit sandbox roots, never credentials or policy choices. */
export function migrateSavedAgentPaths(
  db: Pick<AppDatabase, 'select' | 'update'>,
  remap: (value: string) => string,
): void {
  for (const row of db.select().from(schema.settings).all()) {
    if (typeof row.value !== 'string') continue;
    let value = row.value;
    if (row.key.startsWith('thread-workspace:')) {
      value = remap(value);
    } else if (row.key.startsWith('thread-execution-preferences:')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        continue;
      const preferences = parsed as Record<string, unknown>;
      const security = preferences.security as
        | Record<string, unknown>
        | undefined;
      const policy = security?.sandboxPolicy as
        | Record<string, unknown>
        | undefined;
      if (
        policy?.type !== 'workspaceWrite' ||
        !Array.isArray(policy.writableRoots) ||
        !policy.writableRoots.every(
          (root): root is string => typeof root === 'string',
        )
      )
        continue;
      const writableRoots = policy.writableRoots.map(remap);
      if (
        writableRoots.every(
          (root, index) => root === policy.writableRoots![index],
        )
      )
        continue;
      value = JSON.stringify({
        ...preferences,
        security: { ...security, sandboxPolicy: { ...policy, writableRoots } },
      });
    }
    if (value !== row.value)
      db.update(schema.settings)
        .set({ value })
        .where(eq(schema.settings.key, row.key))
        .run();
  }
}

/** No merging, copying over files, symlink traversal, or deletion during migration. */
export async function migrateManagedProject(
  db: AppDatabase,
  projectId: string,
  root: string,
) {
  if (
    db
      .select()
      .from(schema.projectWorkspaceTransferRuns)
      .all()
      .some((run) => run.projectId === projectId && run.status === 'running')
  )
    throw new ConflictException(
      'Finish the active transfer before migrating the project',
    );
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new ConflictException('Project migration refuses aliased roots');
  const system = projectSystemPath(root);
  const journalName = 'layout-v4.json';
  let journalPath = path.join(system, journalName);
  if (!(await exists(journalPath)))
    journalPath = path.join(projectSystemPath(root, 3), journalName);
  let journal: Journal;
  const saved = await exists(journalPath);
  if (saved) {
    if (!saved.isFile() || saved.isSymbolicLink() || saved.size > 1024 * 1024)
      throw new ConflictException('Invalid layout migration journal');
    journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Journal;
    if (
      journal.projectId !== projectId ||
      journal.version !== 4 ||
      !Array.isArray(journal.moves) ||
      !Number.isSafeInteger(journal.completed) ||
      journal.completed < 0 ||
      journal.completed > journal.moves.length
    )
      throw new ConflictException('Invalid layout migration owner');
  } else {
    const marker = JSON.parse(
      await fs.readFile(
        path.join(projectSystemPath(root, 3), 'project.json'),
        'utf8',
      ),
    ) as { projectId?: string };
    if (marker.projectId !== projectId)
      throw new ConflictException('Project migration owner mismatch');
    const moves: Move[] = [];
    const add = async (from: string, to: string) => {
      if (await exists(from)) moves.push({ from, to });
    };
    await add(projectSystemPath(root, 3), system);
    await add(projectDraftPath(root, 3), projectDraftPath(root));
    await add(path.join(root, 'livrables'), path.join(system, 'livrables'));
    const external = path.join(root, 'sources', '.external');
    const ext = await exists(external);
    // Older installations may contain an empty protected placeholder here.
    // It has no Git copies: preserve it with the imported user sources below.
    const emptyPlaceholder =
      ext?.isFile() && !ext.isSymbolicLink() && ext.size === 0;
    if (ext && !emptyPlaceholder) {
      if (!ext.isDirectory() || ext.isSymbolicLink())
        throw new ConflictException('Invalid legacy Git copy directory');
      for (const name of await fs.readdir(external)) {
        if (name === '.trash') {
          await add(
            path.join(external, name),
            path.join(system, 'operations', 'git-trash'),
          );
          continue;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(name))
          throw new ConflictException('Invalid legacy source identifier');
        await add(
          path.join(external, name),
          path.join(projectSourcesPath(root), name, 'copies'),
        );
      }
    }
    await add(path.join(root, 'documents'), path.join(root, 'dossiers'));
    await add(
      path.join(root, 'sources'),
      path.join(root, 'dossiers', 'sources-importees'),
    );
    // Preserve additional user material. AGENTS.md remains at project root for inheritance.
    for (const name of await fs.readdir(root)) {
      if (
        [
          'documents',
          'sources',
          'livrables',
          'dossiers',
          'AGENTS.md',
          '.mergeron-system',
          '.mergeron-agent-drafts',
        ].includes(name) ||
        name.startsWith('.mergeron-layout-v4')
      )
        continue;
      await add(path.join(root, name), path.join(root, 'dossiers', name));
    }
    for (const connection of await fs.readdir(external).catch(() => [])) {
      if (connection === '.trash') continue;
      const copies = path.join(external, connection);
      const connectionStat = await fs.lstat(copies);
      if (!connectionStat.isDirectory() || connectionStat.isSymbolicLink())
        throw new ConflictException('Unsafe source connection');
      for (const copy of await fs.readdir(copies)) {
        const copyStat = await fs.lstat(path.join(copies, copy));
        if (copyStat.isSymbolicLink())
          throw new ConflictException('Unsafe Git copy root');
        const dotGit = await exists(path.join(copies, copy, '.git'));
        const linked = await exists(
          path.join(copies, copy, '.git', 'worktrees'),
        );
        if (dotGit?.isSymbolicLink() || dotGit?.isFile() || linked)
          throw new ConflictException(
            'Linked Git worktree requires relocation before migration; no files were moved',
          );
      }
    }
    for (const move of moves) {
      const stat = await fs.lstat(move.from);
      if (stat.isSymbolicLink())
        throw new ConflictException('Project migration refuses symbolic roots');
      if (await exists(move.to))
        throw new ConflictException(
          'Project migration destination already exists; nothing was merged',
        );
    }
    journal = { projectId, version: 4, moves, completed: 0 };
    await fs.writeFile(journalPath, JSON.stringify(journal), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const oldWorkspaces = db.select().from(schema.projectWorkspaces).all();
  const oldSelections = db
    .select()
    .from(schema.projectActiveFolders)
    .where(eq(schema.projectActiveFolders.projectId, projectId))
    .all();
  const allowed = (p: string) =>
    p === projectSystemPath(root, 3) ||
    p === projectDraftPath(root, 3) ||
    p.startsWith(root + path.sep);
  for (const move of journal.moves)
    if (
      typeof move.from !== 'string' ||
      typeof move.to !== 'string' ||
      path.resolve(move.from) !== move.from ||
      path.resolve(move.to) !== move.to ||
      !allowed(move.from) ||
      !move.to.startsWith(root + path.sep)
    )
      throw new ConflictException('Migration path escaped project');
  const safeParents = async (target: string) => {
    const parts = path
      .relative(root, path.dirname(target))
      .split(path.sep)
      .filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      await fs.mkdir(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ConflictException('Migration destination parent is unsafe');
    }
  };
  for (let i = journal.completed; i < journal.moves.length; i++) {
    const move = journal.moves[i];
    const before = await exists(move.from),
      after = await exists(move.to);
    if (before && after)
      throw new ConflictException(
        'Ambiguous migration paths; original data retained',
      );
    if (before) {
      if (before.isSymbolicLink())
        throw new ConflictException('Migration source changed');
      await safeParents(move.to);
      if (move.from === path.join(root, 'sources')) {
        const external = path.join(move.from, '.external');
        const remaining = await exists(external);
        if (remaining?.isDirectory() && !remaining.isSymbolicLink())
          await fs.rmdir(external);
        else if (
          remaining &&
          (!remaining.isFile() ||
            remaining.isSymbolicLink() ||
            remaining.size !== 0)
        )
          throw new ConflictException('Invalid legacy Git copy directory');
      }
      await fs.rename(move.from, move.to);
    } else if (!after || after.isSymbolicLink())
      throw new ConflictException(
        'Migration data missing; manual recovery required',
      );
    if (move.from === projectSystemPath(root, 3))
      journalPath = path.join(system, journalName);
    journal.completed = i + 1;
    const temporary = journalPath + '.tmp';
    const stale = await exists(temporary);
    if (stale) {
      if (!stale.isFile() || stale.isSymbolicLink())
        throw new ConflictException('Unsafe migration checkpoint');
      await fs.unlink(temporary);
    }
    await fs.writeFile(temporary, JSON.stringify(journal), {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, journalPath);
  }
  const remap = (value: string): string => {
    // Longest source wins: Git copies are more specific than the old sources root.
    const move = [...journal.moves]
      .sort((a, b) => b.from.length - a.from.length)
      .find((m) => value === m.from || value.startsWith(m.from + path.sep));
    return move ? path.join(move.to, path.relative(move.from, value)) : value;
  };
  const mapValue = (value: unknown): unknown =>
    typeof value === 'string'
      ? remap(value)
      : Array.isArray(value)
        ? value.map(mapValue)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, mapValue(v)]),
            )
          : value;
  // Rewrite only typed filesystem/JSON reference columns, never document bodies or secrets.
  await fs.mkdir(path.join(root, 'dossiers'), { recursive: true });
  await fs.mkdir(path.join(system, 'livrables'), { recursive: true });
  await fs.mkdir(projectSourcesPath(root), { recursive: true });
  await fs.mkdir(projectDraftPath(root), { recursive: true });
  db.transaction((tx) => {
    migrateSavedAgentPaths(tx, remap);
    const tables = [
      [schema.projectWorkspaces, ['path']],
      [schema.projectLocations, ['path']],
      [schema.terminalIdentities, ['cwd']],
      [schema.documentAccessSessions, ['path']],
      [schema.projectAgentThreads, ['workspacePath']],
      [schema.simpleChatThreads, ['cwd']],
      [schema.projectTasks, ['workspacePath', 'linkedFilePath']],
      [schema.projectResources, ['config']],
      [
        schema.projectDeliverableDocuments,
        ['sourcePath', 'previousSourcePaths'],
      ],
      [schema.projectDeliverableVersions, ['files']],
      [
        schema.projectDeliverableDocumentVersions,
        ['sourcePath', 'snapshotPath', 'onlyofficeChangesPath'],
      ],
    ] as const;
    for (const [table, columns] of tables) {
      // Drizzle unions preserve each table's schema at runtime; updates are built from existing rows only.
      const rows = tx.select().from(table).all() as unknown as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const changes: Record<string, unknown> = {};
        for (const column of columns) {
          const value = mapValue(row[column]);
          if (JSON.stringify(value) !== JSON.stringify(row[column]))
            changes[column] = value;
        }
        if (table === schema.projectDeliverableDocuments && changes.sourcePath)
          changes.previousSourcePaths = [
            ...new Set([
              ...(row.previousSourcePaths as string[]),
              row.sourcePath as string,
            ]),
          ];
        if (Object.keys(changes).length) {
          const keys = getTableColumns(table);
          const key = 'id' in keys ? keys.id : keys.threadId;
          tx.update(table)
            .set(changes)
            .where(eq(key, String(row.id ?? row.threadId)))
            .run();
        }
      }
    }
    const relativeSelection = (
      workspaceId: string | null,
      relative: string,
    ) => {
      const workspace = oldWorkspaces.find(
        (w) => w.id === workspaceId && w.projectId === projectId,
      );
      if (!workspace) return relative;
      const mapped = path
        .relative(
          remap(workspace.path),
          remap(path.resolve(workspace.path, relative)),
        )
        .split(path.sep)
        .join('/');
      if (mapped === '..' || mapped.startsWith('../'))
        throw new ConflictException('Transfer escaped its connection');
      return mapped;
    };
    const resources = tx.select().from(schema.projectWorkspaceResources).all();
    for (const transfer of tx
      .select()
      .from(schema.projectWorkspaceTransfers)
      .where(eq(schema.projectWorkspaceTransfers.projectId, projectId))
      .all()) {
      const source = resources.find(
        (resource) =>
          resource.id === transfer.sourceResourceId &&
          resource.projectId === projectId,
      );
      tx.update(schema.projectWorkspaceTransfers)
        .set({
          sourcePath: relativeSelection(
            source?.localWorkspaceId ?? null,
            transfer.sourcePath,
          ),
          destinationPath: relativeSelection(
            transfer.destinationWorkspaceId,
            transfer.destinationPath,
          ),
        })
        .where(eq(schema.projectWorkspaceTransfers.id, transfer.id))
        .run();
    }
    for (const preview of tx
      .select()
      .from(schema.agentPreviews)
      .where(eq(schema.agentPreviews.projectId, projectId))
      .all()) {
      tx.update(schema.agentPreviews)
        .set({ sourcePath: remap(preview.sourcePath) })
        .where(eq(schema.agentPreviews.agentId, preview.agentId))
        .run();
    }
    for (const selection of oldSelections) {
      const workspace = oldWorkspaces.find(
        (w) => w.id === selection.resourceId && w.projectId === projectId,
      );
      if (!workspace) continue;
      const selected = path.resolve(workspace.path, selection.relativePath);
      const mappedRoot = remap(workspace.path);
      const relativePath = path
        .relative(mappedRoot, remap(selected))
        .split(path.sep)
        .join('/');
      if (relativePath === '..' || relativePath.startsWith('../'))
        throw new ConflictException('Reference escaped its connection');
      tx.update(schema.projectActiveFolders)
        .set({ relativePath })
        .where(
          and(
            eq(schema.projectActiveFolders.contextType, selection.contextType),
            eq(schema.projectActiveFolders.contextId, selection.contextId),
          ),
        )
        .run();
    }
    tx.update(schema.projects)
      .set({ workspaceLayoutVersion: WORKSPACE_LAYOUT_VERSION })
      .where(eq(schema.projects.id, projectId))
      .run();
  });
  await fs.writeFile(
    path.join(system, 'project.json'),
    JSON.stringify({ projectId, layoutVersion: WORKSPACE_LAYOUT_VERSION }),
    { mode: 0o600 },
  );
  const instructions = path.join(root, 'AGENTS.md');
  const instructionsStat = await exists(instructions);
  if (
    instructionsStat?.isFile() &&
    !instructionsStat.isSymbolicLink() &&
    (await fs.readFile(instructions, 'utf8')) ===
      SEPARATE_PROJECT_WORKSPACE_INSTRUCTIONS
  )
    await fs.writeFile(instructions, PROJECT_WORKSPACE_INSTRUCTIONS);
  // Retain the completed journal as migration evidence and for path-alias recovery.
}
