import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import {
  projects,
  projectWorkspaces,
  projectResources,
  projectDeliverables,
  projectDeliverableVersions,
  projectDeliverableDocuments,
  projectDeliverableDocumentVersions,
  projectLocations,
  projectAgentThreads,
  simpleChatThreads,
  projectTasks,
  projectActiveFolders,
} from '../database/schema';
import {
  WORKSPACE_LAYOUT_VERSION,
  PROJECT_SYSTEM_DIRECTORY,
  LEGACY_PROJECT_SYSTEM_DIRECTORY,
  PROJECT_CONTENT_DIRECTORIES,
  PROJECT_WORKSPACE_INSTRUCTIONS,
  LEGACY_PROJECT_WORKSPACE_INSTRUCTIONS,
  projectSystemPath,
  PROJECT_SYSTEM_SPACES_DIRECTORY,
  EMBEDDED_PROJECT_WORKSPACE_INSTRUCTIONS,
  projectDraftPath,
} from './workspace-structure';

/** Files belong to the primary workspace; the database only records their location. */
export class ProjectWorkspaceLayout {
  constructor(
    private readonly db: AppDatabase,
    private readonly root = '/workspaces',
  ) {}

  primaryPath(id: string) {
    if (!id || path.basename(id) !== id || id === '.' || id === '..')
      throw new ConflictException('Invalid project identifier');
    return path.join(this.root, id);
  }

  /** Quarantine owned internal data before deleting its DB owner; restore on DB failure. */
  async prepareSystemRemoval(project: {
    id: string;
    workspacePath: string;
    workspaceLayoutVersion: number;
  }) {
    const entries: Array<{
      original: string;
      staged: string;
      ino: number;
      dev: number;
      ownsMarker: boolean;
    }> = [];
    const moved: typeof entries = [];
    const validateParent = async (target: string) => {
      const stat = await fs.lstat(path.dirname(target));
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ConflictException(
          'Project system parent must be a regular directory',
        );
    };
    if (project.workspaceLayoutVersion >= 1) {
      const root = path.resolve(project.workspacePath);
      if (
        !path.isAbsolute(project.workspacePath) ||
        root === path.parse(root).root
      )
        throw new ConflictException('Invalid project system root');
      const system = projectSystemPath(root, project.workspaceLayoutVersion);
      const systems = [
        system,
        ...(project.workspaceLayoutVersion < 3
          ? [path.join(root, LEGACY_PROJECT_SYSTEM_DIRECTORY)]
          : []),
      ];
      for (const original of new Set([...systems, projectDraftPath(root)])) {
        const stat = await this.statIfPresent(original);
        if (!stat) continue;
        await validateParent(original);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new ConflictException(
            'Project system workspace must be a regular directory',
          );
        if (systems.includes(original))
          await this.readMarker(original, project.id);
        entries.push({
          original,
          staged: path.join(
            path.dirname(original),
            `.${path.basename(original)}.deleting-${randomUUID()}`,
          ),
          ino: stat.ino,
          dev: stat.dev,
          ownsMarker: systems.includes(original),
        });
      }
    }
    const requireSameDirectory = async (
      target: string,
      entry: (typeof entries)[number],
    ) => {
      await validateParent(target);
      const stat = await fs.lstat(target);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.ino !== entry.ino ||
        stat.dev !== entry.dev
      )
        throw new ConflictException(
          'Project system workspace changed during deletion',
        );
    };
    const rollback = async () => {
      for (const entry of [...moved].reverse()) {
        await requireSameDirectory(entry.staged, entry);
        if (await this.statIfPresent(entry.original))
          throw new ConflictException(
            'Cannot restore project system workspace over an existing path',
          );
        await fs.rename(entry.staged, entry.original);
        moved.splice(moved.indexOf(entry), 1);
      }
    };
    return {
      paths: entries.map((entry) => entry.original),
      stage: async () => {
        try {
          for (const entry of entries) {
            await requireSameDirectory(entry.original, entry);
            if (entry.ownsMarker)
              await this.readMarker(entry.original, project.id);
            if (await this.statIfPresent(entry.staged))
              throw new ConflictException(
                'Project cleanup destination already exists',
              );
            await fs.rename(entry.original, entry.staged);
            moved.push(entry);
          }
        } catch (error) {
          await rollback();
          throw error;
        }
      },
      rollback,
      purge: async () => {
        for (const entry of moved) {
          await requireSameDirectory(entry.staged, entry);
          await fs.rm(entry.staged, { recursive: true, force: false });
        }
      },
    };
  }

  private async ensureSystemParent(root: string) {
    const parent = path.join(
      path.dirname(root),
      PROJECT_SYSTEM_SPACES_DIRECTORY,
    );
    await fs.mkdir(parent, { recursive: true });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ConflictException(
        'System workspace parent must be a regular directory',
      );
  }

  async prepare(id: string): Promise<string> {
    const target = this.primaryPath(id);
    const owner = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.path, target))
      .get();
    if (owner && owner.projectId !== id)
      throw new ConflictException(
        'Primary workspace path is already attached to another project',
      );
    await fs.mkdir(this.root, { recursive: true });
    const physicalTarget = path.join(await fs.realpath(this.root), id);
    const roots = [
      ...this.db
        .select()
        .from(projectWorkspaces)
        .all()
        .map((w) => ({ projectId: w.projectId, path: w.path })),
      ...this.db
        .select()
        .from(projects)
        .all()
        .map((p) => ({ projectId: p.id, path: p.workspacePath })),
    ];
    for (const root of roots) {
      if (root.projectId === id) continue;
      const physicalRoot = await fs
        .realpath(root.path)
        .catch(() => path.resolve(root.path));
      if (
        physicalTarget === physicalRoot ||
        physicalTarget.startsWith(physicalRoot + path.sep) ||
        physicalRoot.startsWith(physicalTarget + path.sep)
      )
        throw new ConflictException('Project workspaces cannot overlap');
    }
    let created = false;
    try {
      await fs.mkdir(target);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!created) {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new ConflictException(
          'Primary workspace path is not a regular directory',
        );
      await this.migrateSystemDirectory(target, id);
    }
    const system = projectSystemPath(target);
    await this.ensureSystemParent(target);
    if (created && (await this.statIfPresent(system)))
      await this.readMarker(system, id);
    await fs.mkdir(system, { recursive: true });
    for (const relative of [
      PROJECT_SYSTEM_DIRECTORY,
      `${PROJECT_SYSTEM_DIRECTORY}/knowledge`,
      `${PROJECT_SYSTEM_DIRECTORY}/history`,
      ...PROJECT_CONTENT_DIRECTORIES,
    ]) {
      const directory =
        relative === PROJECT_SYSTEM_DIRECTORY ||
        relative.startsWith(PROJECT_SYSTEM_DIRECTORY + '/')
          ? path.join(system, ...relative.split('/').slice(1))
          : path.join(target, relative);
      await fs.mkdir(directory, { recursive: true });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ConflictException(
          'Workspace layout contains a symbolic link',
        );
    }
    const files: Record<string, string> = {
      [`${PROJECT_SYSTEM_DIRECTORY}/project.json`]:
        JSON.stringify(
          { projectId: id, layoutVersion: WORKSPACE_LAYOUT_VERSION },
          null,
          2,
        ) + '\n',
      'AGENTS.md': PROJECT_WORKSPACE_INSTRUCTIONS,
      [`${PROJECT_SYSTEM_DIRECTORY}/knowledge/AGENTS.md`]:
        '# Instructions partagées\n',
      [`${PROJECT_SYSTEM_DIRECTORY}/knowledge/CONNAISSANCES.md`]:
        '# Connaissances du projet\n',
      [`${PROJECT_SYSTEM_DIRECTORY}/knowledge/DECISIONS.md`]:
        '# Décisions du projet\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      try {
        const file = relative.startsWith(PROJECT_SYSTEM_DIRECTORY + '/')
          ? path.join(system, ...relative.split('/').slice(1))
          : path.join(target, relative);
        await fs.writeFile(file, content, {
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return target;
  }

  async migrate(onlyProjectId?: string): Promise<void> {
    for (const project of this.db.select().from(projects).all()) {
      if (onlyProjectId && project.id !== onlyProjectId) continue;
      if (project.workspaceLayoutVersion >= WORKSPACE_LAYOUT_VERSION) continue;
      if (project.workspaceLayoutVersion >= 1) {
        // Missing permanent roots are reported by reconciliation, never recreated.
        if (!(await this.statIfPresent(project.workspacePath))) continue;
        await this.migrateSystemDirectory(project.workspacePath, project.id);
        this.migrateHistoryReferences(project.id, project.workspacePath);
        continue;
      }
      const target = await this.prepare(project.id);
      const now = Date.now();
      this.db.transaction((tx) => {
        const attached = tx
          .select()
          .from(projectWorkspaces)
          .where(eq(projectWorkspaces.projectId, project.id))
          .all();
        if (
          !attached.some(
            (workspace) => workspace.path === project.workspacePath,
          )
        ) {
          tx.insert(projectWorkspaces)
            .values({
              id: randomUUID(),
              projectId: project.id,
              name: 'Ancien workspace',
              path: project.workspacePath,
              primary: false,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        tx.update(projectWorkspaces)
          .set({ primary: false })
          .where(eq(projectWorkspaces.projectId, project.id))
          .run();
        const existing = attached.find(
          (workspace) => workspace.path === target,
        );
        if (existing)
          tx.update(projectWorkspaces)
            .set({ primary: true, name: 'Principal' })
            .where(eq(projectWorkspaces.id, existing.id))
            .run();
        else
          tx.insert(projectWorkspaces)
            .values({
              id: randomUUID(),
              projectId: project.id,
              name: 'Principal',
              path: target,
              primary: true,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        tx.update(projects)
          .set({
            workspacePath: target,
            workspaceLayoutVersion: WORKSPACE_LAYOUT_VERSION,
            updatedAt: now,
          })
          .where(eq(projects.id, project.id))
          .run();
      });
    }
  }

  private async statIfPresent(target: string) {
    try {
      return await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readMarker(directory: string, projectId: string) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ConflictException(
        `Workspace layout must use regular directories: ${directory}`,
      );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(
        path.join(directory, 'project.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096)
        throw new Error('Invalid ownership marker');
      const marker = JSON.parse(await handle.readFile('utf8')) as {
        projectId?: string;
        layoutVersion?: number;
      };
      if (marker.projectId !== projectId)
        throw new ConflictException(
          'Primary workspace belongs to another project',
        );
      if (![1, 2, WORKSPACE_LAYOUT_VERSION].includes(marker.layoutVersion ?? 0))
        throw new ConflictException('Unsupported workspace layout version');
      return marker;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ConflictException(
        `Primary workspace has an invalid ownership marker: ${directory}`,
      );
    } finally {
      await handle?.close();
    }
  }

  /** Rename on the same volume; never merge two system directories. */
  private async migrateSystemDirectory(root: string, projectId: string) {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new ConflictException(
        'Primary workspace path is not a regular directory',
      );
    const legacy = path.join(root, LEGACY_PROJECT_SYSTEM_DIRECTORY);
    const embedded = path.join(root, PROJECT_SYSTEM_DIRECTORY);
    const destination = projectSystemPath(root);
    const [oldStat, newStat] = await Promise.all([
      this.statIfPresent(legacy),
      this.statIfPresent(embedded),
    ]);
    if (oldStat && newStat)
      throw new ConflictException(
        `Both .webui and .mergeron exist; restore a single owned system directory before retrying: ${root}`,
      );
    const separated = await this.statIfPresent(destination);
    if (separated && (oldStat || newStat))
      throw new ConflictException(
        'Both embedded and separated system spaces exist; no directories were merged',
      );
    if (!oldStat && !newStat && !separated)
      throw new ConflictException(
        `Primary workspace already exists without an ownership marker: ${root}`,
      );
    const source = oldStat ? legacy : newStat ? embedded : destination;
    const marker = await this.readMarker(source, projectId);
    // Validate the reserved subdirectories before moving any data.
    for (const name of ['knowledge', 'history']) {
      const directory = path.join(source, name);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ConflictException(
          `Workspace layout contains an invalid directory: ${directory}`,
        );
    }
    for (const name of PROJECT_CONTENT_DIRECTORIES) {
      const directory = path.join(root, name);
      const stat = await this.statIfPresent(directory);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new ConflictException(
          `Workspace layout contains an invalid directory: ${directory}`,
        );
    }
    await this.ensureSystemParent(root);
    // Older imports placed actual user workspaces/attachments under the internal folder.
    // Extract those business files before isolating the system space.
    for (const [name, category] of [
      ['imported-workspaces', 'sources'],
      ['imported-attachments', 'documents'],
    ]) {
      const from = path.join(source, name),
        to = path.join(root, category, name);
      const stat = await this.statIfPresent(from);
      if (!stat) continue;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await this.statIfPresent(to))
      )
        throw new ConflictException(
          'Imported project files have an ambiguous destination; no files were merged',
        );
      await fs.mkdir(path.join(root, category), { recursive: true });
      await fs.rename(from, to);
    }
    if (source !== destination) await fs.rename(source, destination);
    for (const [former, name] of [
      ['.agent-document-drafts', 'draft-archive'],
      ['livrables/.version-staging', 'staging-archive'],
    ]) {
      const from = path.join(root, former),
        to = path.join(destination, name);
      const stat = await this.statIfPresent(from);
      if (!stat) continue;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await this.statIfPresent(to))
      )
        throw new ConflictException(
          'Ambiguous project scratch migration; original data preserved',
        );
      await fs.rename(from, to);
    }
    const draft = projectDraftPath(root);
    const draftStat = await this.statIfPresent(draft);
    if (draftStat) {
      if (!draftStat.isDirectory() || draftStat.isSymbolicLink())
        throw new ConflictException('Invalid agent draft directory');
      const archive = path.join(destination, 'draft-archive');
      await fs.mkdir(archive, { recursive: true });
      if ((await fs.lstat(archive)).isSymbolicLink())
        throw new ConflictException('Invalid draft archive');
      await fs.rename(draft, path.join(archive, randomUUID()));
    }
    for (const name of PROJECT_CONTENT_DIRECTORIES)
      await fs.mkdir(path.join(root, name), { recursive: true });
    if (marker.layoutVersion !== WORKSPACE_LAYOUT_VERSION) {
      const temporary = path.join(destination, `.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(
          temporary,
          JSON.stringify(
            { ...marker, layoutVersion: WORKSPACE_LAYOUT_VERSION },
            null,
            2,
          ) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
        await fs.rename(temporary, path.join(destination, 'project.json'));
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    const instructions = path.join(root, 'AGENTS.md');
    const instructionsStat = await this.statIfPresent(instructions);
    if (
      instructionsStat?.isFile() &&
      !instructionsStat.isSymbolicLink() &&
      [
        LEGACY_PROJECT_WORKSPACE_INSTRUCTIONS,
        EMBEDDED_PROJECT_WORKSPACE_INSTRUCTIONS,
      ].includes(await fs.readFile(instructions, 'utf8'))
    ) {
      const temporary = path.join(root, `.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, PROJECT_WORKSPACE_INSTRUCTIONS, {
          flag: 'wx',
        });
        await fs.rename(temporary, instructions);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  }

  /** Replayable after a crash between the filesystem rename and this transaction. */
  private migrateHistoryReferences(projectId: string, root: string) {
    const destination = projectSystemPath(root);
    const relocate = (value: string) => {
      for (const name of [
        LEGACY_PROJECT_SYSTEM_DIRECTORY,
        PROJECT_SYSTEM_DIRECTORY,
      ]) {
        const former = path.join(root, name);
        for (const [sub, category] of [
          ['imported-workspaces', 'sources'],
          ['imported-attachments', 'documents'],
        ]) {
          const business = path.join(former, sub);
          if (value === business || value.startsWith(business + path.sep))
            return path.join(
              root,
              category,
              sub,
              path.relative(business, value),
            );
        }
        if (value === former || value.startsWith(former + path.sep))
          return destination + value.slice(former.length);
      }
      return value;
    };
    this.db.transaction((tx) => {
      for (const workspace of tx
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .all()) {
        const relocated = relocate(workspace.path);
        if (relocated !== workspace.path)
          tx.update(projectWorkspaces)
            .set({ path: relocated })
            .where(eq(projectWorkspaces.id, workspace.id))
            .run();
      }
      for (const location of tx
        .select()
        .from(projectLocations)
        .where(eq(projectLocations.projectId, projectId))
        .all()) {
        if (location.path)
          tx.update(projectLocations)
            .set({ path: relocate(location.path) })
            .where(eq(projectLocations.id, location.id))
            .run();
      }
      const workspaces = tx
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .all();
      const retainChoice = (
        contextType: 'agent' | 'simple_chat',
        contextId: string,
        cwd: string,
      ) => {
        const workspace = workspaces
          .filter(
            (item) => cwd === item.path || cwd.startsWith(item.path + path.sep),
          )
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (workspace)
          tx.insert(projectActiveFolders)
            .values({
              contextType,
              contextId,
              projectId,
              resourceId: workspace.id,
              relativePath: path.relative(workspace.path, cwd),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
            .onConflictDoNothing()
            .run();
      };
      for (const agent of tx
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.projectId, projectId))
        .all()) {
        const cwd = relocate(agent.workspacePath);
        if (cwd !== agent.workspacePath) {
          tx.update(projectAgentThreads)
            .set({ workspacePath: cwd })
            .where(eq(projectAgentThreads.threadId, agent.threadId))
            .run();
          retainChoice('agent', agent.threadId, cwd);
        }
      }
      for (const chat of tx
        .select()
        .from(simpleChatThreads)
        .where(eq(simpleChatThreads.projectId, projectId))
        .all()) {
        if (chat.cwd) {
          const cwd = relocate(chat.cwd);
          if (cwd !== chat.cwd) {
            tx.update(simpleChatThreads)
              .set({ cwd })
              .where(eq(simpleChatThreads.id, chat.id))
              .run();
            retainChoice('simple_chat', chat.id, cwd);
          }
        }
      }
      const boards = tx
        .select()
        .from(projectResources)
        .where(eq(projectResources.projectId, projectId))
        .all();
      const relocateConfig = (value: unknown): unknown => {
        if (typeof value === 'string') return relocate(value);
        if (Array.isArray(value)) return value.map(relocateConfig);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              relocateConfig(item),
            ]),
          );
        return value;
      };
      for (const board of boards)
        tx.update(projectResources)
          .set({
            config: relocateConfig(board.config) as Record<string, unknown>,
          })
          .where(eq(projectResources.id, board.id))
          .run();
      for (const board of boards)
        for (const task of tx
          .select()
          .from(projectTasks)
          .where(eq(projectTasks.resourceId, board.id))
          .all())
          tx.update(projectTasks)
            .set({
              workspacePath: task.workspacePath
                ? relocate(task.workspacePath)
                : null,
              linkedFilePath: task.linkedFilePath
                ? relocate(task.linkedFilePath)
                : null,
            })
            .where(eq(projectTasks.id, task.id))
            .run();
      const deliverables = tx
        .select({ id: projectDeliverables.id })
        .from(projectDeliverables)
        .innerJoin(
          projectResources,
          eq(projectResources.id, projectDeliverables.resourceId),
        )
        .where(eq(projectResources.projectId, projectId))
        .all();
      for (const deliverable of deliverables) {
        for (const version of tx
          .select()
          .from(projectDeliverableVersions)
          .where(eq(projectDeliverableVersions.deliverableId, deliverable.id))
          .all()) {
          const files = version.files.map((file) => ({
            ...file,
            snapshotPath: relocate(file.snapshotPath),
          }));
          if (
            files.some(
              (file, i) => file.snapshotPath !== version.files[i].snapshotPath,
            )
          )
            tx.update(projectDeliverableVersions)
              .set({ files })
              .where(eq(projectDeliverableVersions.id, version.id))
              .run();
        }
        for (const document of tx
          .select()
          .from(projectDeliverableDocuments)
          .where(eq(projectDeliverableDocuments.deliverableId, deliverable.id))
          .all()) {
          const source = relocate(document.sourcePath);
          if (source !== document.sourcePath)
            tx.update(projectDeliverableDocuments)
              .set({
                sourcePath: source,
                previousSourcePaths: [
                  ...new Set([
                    ...document.previousSourcePaths,
                    document.sourcePath,
                  ]),
                ],
              })
              .where(eq(projectDeliverableDocuments.id, document.id))
              .run();
          for (const version of tx
            .select()
            .from(projectDeliverableDocumentVersions)
            .where(
              eq(projectDeliverableDocumentVersions.documentId, document.id),
            )
            .all()) {
            const snapshotPath = relocate(version.snapshotPath);
            const onlyofficeChangesPath = version.onlyofficeChangesPath
              ? relocate(version.onlyofficeChangesPath)
              : null;
            if (
              snapshotPath !== version.snapshotPath ||
              onlyofficeChangesPath !== version.onlyofficeChangesPath
            )
              tx.update(projectDeliverableDocumentVersions)
                .set({ snapshotPath, onlyofficeChangesPath })
                .where(eq(projectDeliverableDocumentVersions.id, version.id))
                .run();
          }
        }
      }
      tx.update(projects)
        .set({ workspaceLayoutVersion: WORKSPACE_LAYOUT_VERSION })
        .where(eq(projects.id, projectId))
        .run();
    });
  }
}
