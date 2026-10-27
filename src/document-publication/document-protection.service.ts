import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { DatabaseService } from '../database/database.service';
import { projectSystemPath } from '../projects/workspace-structure';
import {
  projects,
  projectWorkspaces,
  projectDeliverableDocuments,
  projectDeliverableDocumentVersions,
  projectDeliverableVersions,
  projectDeliverables,
  projectResources,
} from '../database/schema';
import {
  documentIsolationArgs,
  documentProtectionEnabled,
  type DocumentIsolationPlan,
} from './document-isolation';

/** Fail closed when a deployment requests protection but cannot establish it. */
@Injectable()
export class DocumentProtectionService {
  private async fileHash(file: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file))
      hash.update(chunk as Buffer);
    return hash.digest('hex');
  }
  private fingerprint: string | null = null;
  private unavailableRoots: string[] = [];

  assertWorkspaceAvailable(cwd?: string | null): void {
    if (!cwd) return;
    const target = path.resolve(cwd);
    if (
      this.unavailableRoots.some(
        (root) => target === root || target.startsWith(root + path.sep),
      )
    )
      throw new Error(
        'This project has unavailable retained files or workspaces; repair it before running an agent. Other projects remain available.',
      );
  }

  /** Keep the nearest existing boundary read-only if a registered path vanished. */
  private async availableBoundary(target: string): Promise<string> {
    let candidate = path.resolve(target);
    const missing: string[] = [];
    while (candidate !== path.dirname(candidate)) {
      try {
        const canonical = await fs.realpath(candidate);
        if (
          canonical !== '/workspaces' &&
          !canonical.startsWith('/workspaces/')
        )
          throw new Error(
            'Unavailable protected paths must remain under /workspaces',
          );
        return path.join(canonical, ...missing);
      } catch (error) {
        if (!this.unavailableFile(error)) throw error;
        missing.unshift(path.basename(candidate));
        candidate = path.dirname(candidate);
      }
    }
    throw new Error(
      'Cannot establish a protected boundary for an unavailable path',
    );
  }

  private unavailableFile(error: unknown): boolean {
    return ['ENOENT', 'EACCES', 'ENOTDIR'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    );
  }

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly database: DatabaseService,
  ) {}

  get enabled(): boolean {
    return documentProtectionEnabled();
  }

  /** Creates only Mergeron-owned folders, never follows a replaced directory. */
  async directory(root: string, parts: string[]): Promise<string> {
    let current = await fs.realpath(root);
    for (const part of parts) {
      if (
        !part ||
        path.basename(part) !== part ||
        part === '.' ||
        part === '..'
      )
        throw new Error('Invalid publication directory');
      current = path.join(current, part);
      await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Publication directories must not be symbolic links');
    }
    return current;
  }

  async plan(): Promise<DocumentIsolationPlan | null> {
    if (!this.enabled) return null;
    if (process.platform !== 'linux')
      throw new Error(
        'Published document protection requires the Linux isolation runtime',
      );
    await fs.access('/usr/bin/bwrap', fs.constants.X_OK);
    const home = await fs.realpath(
      process.env.CODEX_HOME || path.join(homedir(), '.codex'),
    );
    const ssh = path.join(path.dirname(home), '.ssh');
    await fs
      .mkdir(ssh, { mode: 0o700 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    if (
      !(await fs.lstat(ssh)).isDirectory() ||
      (await fs.lstat(ssh)).isSymbolicLink()
    )
      throw new Error('The server SSH directory must not be a symbolic link');
    const quarantined = new Set<string>();
    const boundaries = new Set<string>();
    const missingBoundaries = new Set<string>();
    const quarantine = async (target: string) => {
      const boundary = await this.availableBoundary(target);
      quarantined.add(path.resolve(target));
      quarantined.add(boundary);
      if (
        await fs
          .access(boundary)
          .then(() => true)
          .catch(() => false)
      )
        boundaries.add(boundary);
      else missingBoundaries.add(boundary);
    };
    const workspaces = this.db.select().from(projectWorkspaces).all();
    const workspaceRoots = await Promise.all(
      workspaces.map(async (workspace) => ({
        projectId: workspace.projectId,
        root: await fs.realpath(workspace.path).catch(async (error) => {
          if (!this.unavailableFile(error)) throw error;
          await quarantine(workspace.path);
          return null;
        }),
      })),
    );
    if (
      workspaceRoots.some(
        ({ root }) =>
          root !== null &&
          root !== '/workspaces' &&
          !root.startsWith('/workspaces/'),
      )
    )
      throw new Error(
        'Protected agents require a working copy under /workspaces',
      );
    const publishedRoots: string[] = [];
    const privateRoots: string[] = [];
    for (const project of this.db.select().from(projects).all()) {
      if (project.workspaceLayoutVersion < 1) continue;
      const root = await fs
        .realpath(project.workspacePath)
        .catch(async (error) => {
          if (!this.unavailableFile(error)) throw error;
          await quarantine(project.workspacePath);
          return null;
        });
      if (!root) continue;
      if (root !== '/workspaces' && !root.startsWith('/workspaces/'))
        throw new Error(
          'Protected projects require a primary workspace under /workspaces',
        );
      try {
        publishedRoots.push(await this.directory(root, ['livrables']));
        if (project.workspaceLayoutVersion >= 3) {
          const system = projectSystemPath(root);
          const parent = path.dirname(system);
          for (const directory of [parent, system]) {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink())
              throw new Error('Invalid system workspace boundary');
            if (directory === parent)
              privateRoots.push(await fs.realpath(parent));
          }
          publishedRoots.push(await fs.realpath(system));
        } else publishedRoots.push(await this.directory(root, ['.mergeron']));
      } catch (error) {
        if (!this.unavailableFile(error)) throw error;
        await quarantine(root);
      }
    }
    const writableRoots = new Set<string>();
    for (const workspace of workspaceRoots)
      if (workspace.root) writableRoots.add(workspace.root);
    // Projectless code remains editable without exposing appdata/stack backups.
    if (
      await fs
        .stat('/workspaces')
        .then((stat) => stat.isDirectory())
        .catch(() => false)
    )
      writableRoots.add('/workspaces');
    const legacy = this.db
      .select({ document: projectDeliverableDocuments, project: projects })
      .from(projectDeliverableDocuments)
      .innerJoin(
        projectDeliverables,
        eq(projectDeliverables.id, projectDeliverableDocuments.deliverableId),
      )
      .innerJoin(
        projectResources,
        eq(projectResources.id, projectDeliverables.resourceId),
      )
      .innerJoin(projects, eq(projects.id, projectResources.projectId))
      .all();
    for (const { document, project } of legacy) {
      const sourceStat = await fs
        .lstat(document.sourcePath)
        .catch(async (error) => {
          if (!this.unavailableFile(error)) throw error;
          await quarantine(project.workspacePath);
          await quarantine(path.dirname(document.sourcePath));
          return null;
        });
      if (!sourceStat) continue;
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
        throw new Error('A retained document source must be a regular file');
      const source = await fs.realpath(document.sourcePath);
      const root = await fs.realpath(project.workspacePath);
      if (
        !workspaceRoots.some(
          (workspace) =>
            workspace.projectId === project.id &&
            workspace.root !== null &&
            source.startsWith(workspace.root + path.sep),
        )
      )
        throw new Error(
          'A retained document source escaped its project workspace',
        );
      if (sourceStat.nlink !== 1)
        throw new Error(
          'Retained document sources must not share writable hardlinks',
        );
      if (source.startsWith(path.join(root, 'livrables') + path.sep)) continue;
      // Preserve the original as a draft: relocation never deletes user files.
      const folder = await this.directory(root, [
        'livrables',
        document.deliverableId,
      ]);
      const target = path.join(folder, path.basename(document.name));
      const before = await fs.stat(source);
      const sourceHash = await this.fileHash(source);
      try {
        await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error('Invalid retained document destination');
      }
      const after = await fs.stat(source);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        (await this.fileHash(source)) !== sourceHash ||
        (await this.fileHash(target)) !== sourceHash
      )
        throw new Error(
          'A document changed during protected relocation; retry after its editor closes',
        );
      this.db
        .update(projectDeliverableDocuments)
        .set({
          sourcePath: target,
          previousSourcePaths: [
            ...new Set([
              ...(document.previousSourcePaths ?? []),
              document.sourcePath,
              source,
            ]),
          ],
        })
        .where(
          and(
            eq(projectDeliverableDocuments.id, document.id),
            eq(projectDeliverableDocuments.sourcePath, document.sourcePath),
          ),
        )
        .run();
    }
    const snapshots = new Set(
      this.db
        .select()
        .from(projectDeliverableDocumentVersions)
        .all()
        .map((version) => version.snapshotPath),
    );
    for (const version of this.db
      .select()
      .from(projectDeliverableVersions)
      .all())
      for (const file of version.files) snapshots.add(file.snapshotPath);
    for (const snapshot of snapshots) {
      const stat = await fs.lstat(snapshot).catch(async (error) => {
        if (!this.unavailableFile(error)) throw error;
        await quarantine(path.dirname(snapshot));
        return null;
      });
      if (!stat) continue;
      const canonical = await fs.realpath(snapshot);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        !publishedRoots.some((root) => canonical.startsWith(root + path.sep))
      )
        throw new Error(
          'Document history must be regular, unaliased files in the protected project history',
        );
    }
    const plan = {
      home,
      databasePath: this.database.databasePath,
      writableRoots: [...writableRoots].sort(),
      publishedRoots: [...new Set([...publishedRoots, ...boundaries])].sort(),
      privateRoots: [...new Set(privateRoots)].sort(),
      unavailableRoots: [...missingBoundaries].sort(),
    };
    // Validate broad roots before starting or restarting a process.
    documentIsolationArgs(plan, '/unused', []);
    this.unavailableRoots = [...quarantined];
    return plan;
  }

  key(plan: DocumentIsolationPlan | null): string {
    return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  }

  changed(plan: DocumentIsolationPlan | null): boolean {
    return this.fingerprint !== this.key(plan);
  }

  accept(plan: DocumentIsolationPlan | null): void {
    this.fingerprint = this.key(plan);
  }
}
