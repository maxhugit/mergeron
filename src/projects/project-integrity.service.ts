import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import * as schema from '../database/schema';
import { projectSystemAlias } from './project-system-paths';
import { serializeProjectLayout } from './project-layout-lock';

export type IntegrityIssue = {
  id: string;
  kind: string;
  path: string;
  entityId?: string;
  severity: 'error' | 'warning';
  action:
    | 'create-directory'
    | 'realign-agent'
    | 'realign-override'
    | 'select-project-folder'
    | null;
  expectedPath?: string;
  reference?: {
    contextType: schema.ProjectActiveFolder['contextType'];
    contextId: string;
    label: string;
    resourceId: string;
    relativePath: string;
  };
};
export type IntegrityReport = {
  projectId: string;
  name: string;
  root: string;
  inspectedAt: number;
  fingerprint: string;
  issues: IntegrityIssue[];
  limited: boolean;
  counts: { documents: number; versions: number; copies: number };
};
const inside = (root: string, value: string) =>
  value === root || value.startsWith(root + path.sep);
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stat = async (p: string) =>
  fs.lstat(p).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  });

/** Administrative reconciliation: never reads document bytes, deletes data or adopts unknown files. */
@Injectable()
export class ProjectIntegrityService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    @Optional()
    @Inject('PROJECT_INTEGRITY_ROOT')
    private readonly projectsRoot = '/workspaces',
  ) {}

  list() {
    return this.db
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .all();
  }

  async inspect(projectId: string): Promise<IntegrityReport> {
    const project = this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    if (!project) throw new NotFoundException('Project not found');
    const root = path.resolve(project.workspacePath);
    const issues: IntegrityIssue[] = [];
    const seenIssues = new Set<string>();
    const facts: unknown[] = [project];
    let limited = false;
    const add = (
      kind: string,
      p: string,
      severity: IntegrityIssue['severity'] = 'error',
      action: IntegrityIssue['action'] = null,
      entityId?: string,
      expectedPath?: string,
      reference?: IntegrityIssue['reference'],
    ) => {
      if (issues.length >= 500 && kind !== 'scan-limited') {
        limited = true;
        return;
      }
      const id = digest([kind, p, entityId, reference?.contextType]).slice(
        0,
        32,
      );
      if (seenIssues.has(id)) return;
      seenIssues.add(id);
      issues.push({
        id,
        kind,
        path: p,
        severity,
        action,
        ...(entityId ? { entityId } : {}),
        ...(expectedPath ? { expectedPath } : {}),
        ...(reference ? { reference } : {}),
      });
    };
    // Walk every ancestor with lstat; do not inspect a symlink target, including an external connection.
    let probes = 0;
    const safe = async (p: string) => {
      if (++probes > 10000) {
        limited = true;
        return false;
      }
      if (path.resolve(p) !== p || !inside(root, p)) {
        add('outside-project', p);
        return false;
      }
      const components = path.resolve(p).split(path.sep).filter(Boolean);
      let current = path.parse(p).root;
      for (const component of components) {
        current = path.join(current, component);
        const s = await stat(current);
        facts.push([
          current,
          s
            ? [
                s.dev,
                s.ino,
                s.mode,
                ...(inside(root, current) ? [s.size, s.mtimeMs] : []),
              ]
            : null,
        ]);
        if (!s) return true;
        if (s.isSymbolicLink()) {
          add('symbolic-link', current);
          return false;
        }
        if (current !== p && !s.isDirectory()) {
          add('path-collision', current);
          return false;
        }
      }
      return true;
    };
    if (
      root !== path.join(this.projectsRoot, project.id) ||
      project.workspacePath !== root
    ) {
      add('project-location-mismatch', project.workspacePath);
      return this.report(project, issues, facts, false, {
        documents: 0,
        versions: 0,
        copies: 0,
      });
    }
    const rootSafe = await safe(root);
    const rootStat = rootSafe ? await stat(root) : null;
    if (!rootSafe || !rootStat?.isDirectory()) {
      if (rootSafe) add('project-root-missing', root);
      return this.report(project, issues, facts, limited, {
        documents: 0,
        versions: 0,
        copies: 0,
      });
    }
    if (project.workspaceLayoutVersion !== 4) add('migration-required', root);
    const system = path.join(root, '.mergeron-system');
    const markerPath = path.join(system, 'project.json');
    let owned = false;
    if (await safe(markerPath)) {
      const marker = await stat(markerPath);
      if (marker?.isFile() && marker.size <= 16384) {
        try {
          const value: unknown = JSON.parse(
            await fs.readFile(markerPath, 'utf8'),
          );
          facts.push(value);
          owned =
            !!value &&
            typeof value === 'object' &&
            (value as { projectId?: unknown }).projectId === project.id;
        } catch {
          /* invalid marker remains a diagnostic */
        }
      }
    }
    if (!owned) add('project-identity-mismatch', markerPath);
    const resources = this.db
      .select()
      .from(schema.projectResources)
      .where(eq(schema.projectResources.projectId, projectId))
      .all();
    const resourceIds = new Set(resources.map((r) => r.id));
    const deliverables = this.db
      .select()
      .from(schema.projectDeliverables)
      .all()
      .filter((d) => resourceIds.has(d.resourceId));
    const deliverableIds = new Set(deliverables.map((d) => d.id));
    const documents = this.db
      .select()
      .from(schema.projectDeliverableDocuments)
      .all()
      .filter((d) => deliverableIds.has(d.deliverableId));
    const documentIds = new Set(documents.map((d) => d.id));
    const versions = this.db
      .select()
      .from(schema.projectDeliverableDocumentVersions)
      .all()
      .filter((v) => documentIds.has(v.documentId));
    const workspaces = this.db
      .select()
      .from(schema.projectWorkspaces)
      .where(eq(schema.projectWorkspaces.projectId, projectId))
      .all();
    const copies = this.db
      .select()
      .from(schema.projectWorkspaceCopies)
      .where(eq(schema.projectWorkspaceCopies.projectId, projectId))
      .all();
    const agents = this.db
      .select()
      .from(schema.projectAgentThreads)
      .where(eq(schema.projectAgentThreads.projectId, projectId))
      .all();
    const folders = this.db
      .select()
      .from(schema.projectActiveFolders)
      .where(eq(schema.projectActiveFolders.projectId, projectId))
      .all();
    const transfers = this.db
      .select()
      .from(schema.projectWorkspaceTransferRuns)
      .all()
      .filter((t) => t.projectId === projectId && t.status === 'running');
    const overrides = this.db
      .select()
      .from(schema.settings)
      .all()
      .filter((row) =>
        agents.some(
          (agent) => row.key === 'thread-workspace:' + agent.threadId,
        ),
      );
    facts.push(
      resources,
      deliverables,
      documents,
      versions,
      workspaces,
      copies,
      agents,
      transfers,
      overrides,
      folders,
    );
    const editable =
      owned && project.workspaceLayoutVersion === 4 && !transfers.length;
    if (transfers.length) add('transfer-running', root, 'warning');
    const directory = async (p: string, canCreate: boolean) => {
      if (!(await safe(p))) return;
      const s = await stat(p);
      if (!s) {
        const parent = await stat(path.dirname(p));
        add(
          'directory-missing',
          p,
          'error',
          editable &&
            canCreate &&
            parent?.isDirectory() &&
            process.platform === 'linux'
            ? 'create-directory'
            : null,
        );
      } else if (!s.isDirectory()) add('path-collision', p);
    };
    await directory(path.join(root, 'dossiers'), true);
    await directory(path.join(root, '.mergeron-agent-drafts'), true);
    for (const name of ['livrables', 'sources', 'history', 'knowledge']) {
      // A missing history may contain lost immutable versions; do not replace it by an empty directory.
      await directory(
        path.join(system, name),
        name !== 'history' || !versions.length,
      );
    }
    for (const d of deliverables) {
      const p = path.join(system, 'livrables', d.id);
      if (!inside(path.join(system, 'livrables'), p)) {
        add('outside-project', p);
        continue;
      }
      await directory(p, !documents.some((doc) => doc.deliverableId === d.id));
    }
    const checkFile = async (p: string, kind: string, entityId: string) => {
      if (!(await safe(p))) return;
      const s = await stat(p);
      if (!s?.isFile()) add(kind, p, 'error', null, entityId);
    };
    for (const d of documents.filter((d) => d.deletedAt === null)) {
      if (
        !inside(
          path.join(system, 'livrables', d.deliverableId),
          path.resolve(d.sourcePath),
        )
      )
        add('document-location-mismatch', d.sourcePath, 'error', null, d.id);
      await checkFile(d.sourcePath, 'document-missing', d.id);
      if (
        d.currentVersionNumber > 0 &&
        !versions.some(
          (v) => v.documentId === d.id && v.number === d.currentVersionNumber,
        )
      )
        add('current-version-missing', d.sourcePath, 'error', null, d.id);
    }
    for (const v of versions) {
      if (!inside(path.join(system, 'history'), path.resolve(v.snapshotPath)))
        add('snapshot-location-mismatch', v.snapshotPath, 'error', null, v.id);
      await checkFile(v.snapshotPath, 'snapshot-missing', v.id);
      if (v.onlyofficeChangesPath)
        await checkFile(v.onlyofficeChangesPath, 'snapshot-missing', v.id);
    }
    for (const workspace of workspaces) {
      if (workspace.primary && workspace.path !== root)
        add(
          'primary-location-mismatch',
          workspace.path,
          'error',
          null,
          workspace.id,
          root,
        );
    }
    const tasks = this.db
      .select()
      .from(schema.projectTasks)
      .all()
      .filter((t) => resourceIds.has(t.resourceId));
    const chats = this.db
      .select()
      .from(schema.simpleChatThreads)
      .all()
      .filter((t) => t.projectId === projectId);
    facts.push(tasks, chats);
    const primary = workspaces.find((w) => w.primary && w.path === root);
    const foldersPath = path.join(root, 'dossiers');
    let canSelectFolders =
      editable &&
      !!primary &&
      (await safe(foldersPath)) &&
      (await stat(foldersPath))?.isDirectory();
    const locations = this.db
      .select()
      .from(schema.projectLocations)
      .where(eq(schema.projectLocations.projectId, projectId))
      .all();
    facts.push(locations);
    if (canSelectFolders) {
      try {
        new ActiveFoldersService(this.db).validateSelection(projectId, {
          resourceId: primary!.id,
          relativePath: 'dossiers',
        });
      } catch {
        canSelectFolders = false;
      }
    }
    for (const folder of folders) {
      const workspace = workspaces.find((w) => w.id === folder.resourceId);
      if (!workspace) {
        add(
          'active-folder-registration-missing',
          root,
          'warning',
          canSelectFolders &&
            (folder.contextType === 'agent'
              ? agents.some((a) => a.threadId === folder.contextId)
              : folder.contextType === 'task'
                ? tasks.some((t) => t.id === folder.contextId)
                : folder.contextType === 'deliverable'
                  ? deliverables.some((d) => d.id === folder.contextId)
                  : chats.some((c) => c.id === folder.contextId))
            ? 'select-project-folder'
            : null,
          folder.contextId,
          canSelectFolders ? foldersPath : undefined,
          {
            contextType: folder.contextType,
            contextId: folder.contextId,
            label:
              (folder.contextType === 'task'
                ? tasks.find((t) => t.id === folder.contextId)?.title
                : folder.contextType === 'deliverable'
                  ? deliverables.find((d) => d.id === folder.contextId)?.title
                  : folder.contextType === 'simple_chat'
                    ? chats.find((c) => c.id === folder.contextId)?.title
                    : null) ?? folder.contextId,
            resourceId: folder.resourceId,
            relativePath: folder.relativePath,
          },
        );
        continue;
      }
      const location = path.resolve(workspace.path, folder.relativePath);
      if (!inside(workspace.path, location))
        add(
          'active-folder-outside-workspace',
          location,
          'error',
          null,
          folder.contextId,
        );
      else if (
        inside(root, location) &&
        (await safe(location)) &&
        !(await stat(location))?.isDirectory()
      )
        add(
          'active-folder-missing',
          location,
          'warning',
          null,
          folder.contextId,
        );
    }
    for (const copy of copies) {
      const workspace = workspaces.find((w) => w.id === copy.localWorkspaceId);
      if (!workspace) {
        add('copy-registration-missing', system, 'error', null, copy.id);
        continue;
      }
      const expected = path.join(
        system,
        'sources',
        copy.sourceResourceId,
        'copies',
        copy.id,
      );
      if (workspace.path !== expected)
        add(
          'copy-location-mismatch',
          workspace.path,
          'error',
          null,
          copy.id,
          expected,
        );
      if (await safe(workspace.path)) {
        const s = await stat(workspace.path);
        if (!s?.isDirectory())
          add('copy-missing', workspace.path, 'error', null, copy.id);
        else if (await safe(path.join(workspace.path, '.git'))) {
          const git = await stat(path.join(workspace.path, '.git'));
          if (!git?.isDirectory() && !git?.isFile())
            add('git-metadata-missing', workspace.path, 'error', null, copy.id);
        }
      }
    }
    for (const agent of agents) {
      if (!inside(root, agent.workspacePath)) continue; // Secondary local connections are independent.
      const mapped = projectSystemAlias(this.db, agent.workspacePath);
      if (
        mapped !== agent.workspacePath &&
        (await safe(mapped)) &&
        (await stat(mapped))?.isDirectory()
      )
        add(
          'agent-reference-obsolete',
          agent.workspacePath,
          'warning',
          editable ? 'realign-agent' : null,
          agent.threadId,
          mapped,
        );
      else if (
        (await safe(agent.workspacePath)) &&
        !(await stat(agent.workspacePath))?.isDirectory()
      )
        add(
          'agent-reference-missing',
          agent.workspacePath,
          'warning',
          null,
          agent.threadId,
        );
    }
    for (const override of overrides) {
      if (!override.value || !inside(root, override.value)) continue;
      const mapped = projectSystemAlias(this.db, override.value);
      if (
        mapped !== override.value &&
        (await safe(mapped)) &&
        (await stat(mapped))?.isDirectory()
      )
        add(
          'agent-override-obsolete',
          override.value,
          'warning',
          editable ? 'realign-override' : null,
          override.key,
          mapped,
        );
      else if (
        (await safe(override.value)) &&
        !(await stat(override.value))?.isDirectory()
      )
        add(
          'agent-reference-missing',
          override.value,
          'warning',
          null,
          override.key,
        );
    }
    const listDirectory = async (p: string) => {
      if (!(await safe(p)) || !(await stat(p))?.isDirectory()) return [];
      const names: string[] = [];
      for await (const entry of await fs.opendir(p)) {
        if (names.length === 1000) {
          limited = true;
          break;
        }
        names.push(entry.name);
      }
      names.sort();
      facts.push([p, names]);
      return names;
    };
    for (const name of await listDirectory(path.join(system, 'livrables'))) {
      if (
        !deliverableIds.has(name) &&
        (await safe(path.join(system, 'livrables', name))) &&
        (await stat(path.join(system, 'livrables', name)))?.isDirectory()
      )
        add(
          'unregistered-deliverable-directory',
          path.join(system, 'livrables', name),
          'warning',
        );
    }
    for (const connection of await listDirectory(
      path.join(system, 'sources'),
    )) {
      for (const name of await listDirectory(
        path.join(system, 'sources', connection, 'copies'),
      )) {
        if (
          !copies.some(
            (c) => c.id === name && c.sourceResourceId === connection,
          )
        )
          add(
            'unregistered-copy',
            path.join(system, 'sources', connection, 'copies', name),
            'warning',
          );
      }
    }
    // Inventory only managed projections. User Dossiers are free material, never "orphans".
    let visited = 0;
    const expectedFiles = new Set(
      documents.map((d) => path.resolve(d.sourcePath)),
    );
    const walk = async (p: string, depth: number) => {
      if (++visited > 5000 || depth > 16) {
        limited = true;
        return;
      }
      if (!(await safe(p))) return;
      const s = await stat(p);
      if (!s) return;
      if (s.isFile()) {
        if (!expectedFiles.has(p)) add('unregistered-document', p, 'warning');
        return;
      }
      if (!s.isDirectory()) return;
      const entries: string[] = [];
      for await (const entry of await fs.opendir(p)) {
        if (entries.length === 5000) {
          limited = true;
          break;
        }
        entries.push(entry.name);
      }
      entries.sort();
      facts.push([p, entries]);
      for (const n of entries) {
        if (visited >= 5000) {
          limited = true;
          break;
        }
        await walk(path.join(p, n), depth + 1);
      }
    };
    await walk(path.join(system, 'livrables'), 0);
    if (limited) {
      add('scan-limited', system, 'warning');
      for (const issue of issues) issue.action = null;
    }
    return this.report(project, issues, facts, limited, {
      documents: documents.length,
      versions: versions.length,
      copies: copies.length,
    });
  }

  private report(
    project: typeof schema.projects.$inferSelect,
    issues: IntegrityIssue[],
    facts: unknown[],
    limited: boolean,
    counts: IntegrityReport['counts'],
  ): IntegrityReport {
    return {
      projectId: project.id,
      name: project.name,
      root: project.workspacePath,
      inspectedAt: Date.now(),
      fingerprint: digest([facts, issues]),
      issues,
      limited,
      counts,
    };
  }

  async repair(
    projectId: string,
    body: { fingerprint?: unknown; issueId?: unknown; confirmation?: unknown },
    actor: { personId: string | null; name: string },
  ) {
    if (
      !body ||
      typeof body !== 'object' ||
      body.confirmation !== 'REPAIR_PROJECT' ||
      typeof body.fingerprint !== 'string' ||
      typeof body.issueId !== 'string'
    )
      throw new BadRequestException('Explicit repair confirmation required');
    return serializeProjectLayout(this.db, async () => {
      const report = await this.inspect(projectId);
      if (report.fingerprint !== body.fingerprint)
        throw new ConflictException(
          'Diagnostic changed; inspect again before repairing',
        );
      const issue = report.issues.find((i) => i.id === body.issueId);
      if (!issue?.action)
        throw new ConflictException('No safe automatic correction available');
      if (issue.action === 'create-directory')
        await this.createAnchoredDirectory(report.root, issue.path);
      this.db.transaction(() => {
        if (issue.action === 'select-project-folder') {
          const reference = issue.reference!;
          const primary = this.db
            .select()
            .from(schema.projectWorkspaces)
            .where(eq(schema.projectWorkspaces.projectId, projectId))
            .all()
            .find((w) => w.primary && w.path === report.root);
          if (
            !primary ||
            issue.expectedPath !== path.join(report.root, 'dossiers')
          )
            throw new ConflictException('Project folder changed');
          new ActiveFoldersService(this.db).set(
            projectId,
            reference.contextType,
            reference.contextId,
            { resourceId: primary.id, relativePath: 'dossiers' },
          );
        }
        if (issue.action === 'realign-agent') {
          const current = this.db
            .select()
            .from(schema.projectAgentThreads)
            .where(eq(schema.projectAgentThreads.threadId, issue.entityId!))
            .get();
          if (
            !current ||
            current.projectId !== projectId ||
            current.workspacePath !== issue.path
          )
            throw new ConflictException('Agent reference changed');
          this.db
            .update(schema.projectAgentThreads)
            .set({ workspacePath: issue.expectedPath!, updatedAt: Date.now() })
            .where(eq(schema.projectAgentThreads.threadId, issue.entityId!))
            .run();
        }
        if (issue.action === 'realign-override') {
          const current = this.db
            .select()
            .from(schema.settings)
            .where(eq(schema.settings.key, issue.entityId!))
            .get();
          if (current?.value !== issue.path)
            throw new ConflictException('Agent reference changed');
          this.db
            .update(schema.settings)
            .set({ value: issue.expectedPath!, updatedAt: Date.now() })
            .where(eq(schema.settings.key, issue.entityId!))
            .run();
        }
        this.db
          .insert(schema.projectActivity)
          .values({
            id: randomUUID(),
            projectId,
            action: 'integrity.repair',
            entityType: 'project',
            entityId: projectId,
            label: issue.kind,
            details: {
              path: issue.path,
              action: issue.action,
              expectedPath: issue.expectedPath,
              reference: issue.reference,
            },
            actorPersonId: actor.personId,
            actorName: actor.name,
            createdAt: Date.now(),
          })
          .run();
      });
      return this.inspect(projectId);
    });
  }

  /** Linux descriptor-relative creation: no recursive mkdir and no symlink traversal race. */
  private async createAnchoredDirectory(root: string, target: string) {
    if (process.platform !== 'linux' || !inside(root, target))
      throw new ConflictException('Safe directory creation unavailable');
    const handles: fs.FileHandle[] = [];
    try {
      let handle = await fs.open(
        '/',
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      for (const component of path.dirname(target).split('/').filter(Boolean)) {
        handle = await fs.open(
          `/proc/self/fd/${handle.fd}/${component}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        handles.push(handle);
      }
      await fs.mkdir(`/proc/self/fd/${handle.fd}/${path.basename(target)}`, {
        mode: 0o700,
      });
    } catch {
      throw new ConflictException(
        'Directory changed or could not be safely created; inspect again',
      );
    } finally {
      for (const handle of handles.reverse()) await handle.close();
    }
  }
}
