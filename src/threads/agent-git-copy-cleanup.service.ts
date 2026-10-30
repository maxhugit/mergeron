import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { lstat, realpath, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectActiveFolders,
  projectAgentThreads,
  projectLocations,
  projectWorkspaceCopies,
  projectWorkspaceResources,
  projectWorkspaces,
  simpleChatThreads,
  type ProjectWorkspaceCopy,
} from '../database/schema';
import { copyAgentIds, workAgentId } from '../projects/git-copy-ownership';
import { GitMutationGateService } from './git-mutation-gate.service';

/** Removes only managed local copies, after their conversation was deleted. */
@Injectable()
export class AgentGitCopyCleanupService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly gate: GitMutationGateService,
  ) {}

  async cleanup(threadId: string): Promise<void> {
    // A message version shares its work agent's copy. Deleting that version
    // alone must not remove the surviving agent's checkout.
    const copies =
      workAgentId(this.db, threadId) === threadId
        ? this.db
            .select()
            .from(projectWorkspaceCopies)
            .all()
            .filter((copy) =>
              copyAgentIds(this.db, copy.projectId, copy.id).includes(threadId),
            )
        : [];
    if (copies.length) {
      await this.gate.mutate(async () => {
        for (const copy of copies) await this.removeCopy(copy, threadId);
      });
    }
    this.db.transaction((tx) => {
      tx.delete(projectActiveFolders)
        .where(
          and(
            eq(projectActiveFolders.contextType, 'agent'),
            eq(projectActiveFolders.contextId, threadId),
          ),
        )
        .run();
      tx.delete(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, threadId))
        .run();
    });
  }

  private async removeCopy(copy: ProjectWorkspaceCopy, threadId: string) {
    if (
      copyAgentIds(this.db, copy.projectId, copy.id).some(
        (owner) => owner !== threadId,
      )
    )
      throw new ConflictException('GIT_COPY_IN_USE');
    const workspaces = this.db.select().from(projectWorkspaces).all();
    const workspace = workspaces.find(
      (row) => row.id === copy.localWorkspaceId,
    );
    const primary = workspaces.find(
      (row) => row.projectId === copy.projectId && row.primary,
    );
    if (!workspace || !primary)
      throw new ConflictException('Working copy is detached');
    const target = path.resolve(workspace.path);
    const allowed = path.resolve(primary.path, 'sources', '.external');
    if (
      workspace.primary ||
      workspace.projectId !== copy.projectId ||
      !/^[A-Za-z0-9_-]+$/.test(copy.sourceResourceId) ||
      !/^[A-Za-z0-9_-]+$/.test(copy.id) ||
      target !== path.join(allowed, copy.sourceResourceId, copy.id)
    )
      throw new ConflictException('GIT_COPY_PATH_UNSAFE');

    const root = await realpath(primary.path);
    // Never follow a symlink, including a symlink in an ancestor directory.
    // An already absent checkout is still eligible for metadata cleanup.
    for (const candidate of [
      path.join(primary.path, 'sources'),
      allowed,
      path.dirname(target),
      target,
    ]) {
      const entry = await lstat(candidate).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (!entry) break;
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        (await realpath(candidate)) !==
          path.resolve(root, path.relative(primary.path, candidate))
      )
        throw new ConflictException('GIT_COPY_PATH_UNSAFE');
    }

    const locations = this.db.select().from(projectLocations).all();
    const aliases = new Set([
      copy.id,
      workspace.id,
      `local:${workspace.id}`,
      ...locations
        .filter((row) => row.localWorkspaceId === workspace.id)
        .map((row) => row.id),
    ]);
    const folders = this.db
      .select()
      .from(projectActiveFolders)
      .all()
      .filter(
        (row) => row.contextType !== 'agent' || row.contextId !== threadId,
      );
    if (folders.some((row) => aliases.has(row.resourceId)))
      throw new ConflictException('GIT_COPY_IN_USE');
    const references = [
      ...this.db
        .select()
        .from(projectAgentThreads)
        .all()
        .filter((row) => row.threadId !== threadId)
        .map((row) => row.workspacePath),
      ...this.db
        .select()
        .from(simpleChatThreads)
        .all()
        .map((row) => row.cwd),
      ...folders.map((row) => {
        const base =
          workspaces.find(
            (item) =>
              item.id === row.resourceId ||
              `local:${item.id}` === row.resourceId,
          )?.path ??
          locations.find(
            (item) =>
              item.id === row.resourceId ||
              item.legacyResourceId === row.resourceId,
          )?.path;
        return base ? path.resolve(base, row.relativePath) : null;
      }),
    ];
    const canonicalTarget = path.join(
      root,
      'sources',
      '.external',
      copy.sourceResourceId,
      copy.id,
    );
    for (const reference of references) {
      if (!reference) continue;
      const resolved = await realpath(reference).catch(() =>
        path.resolve(reference),
      );
      if (
        resolved === canonicalTarget ||
        resolved.startsWith(canonicalTarget + path.sep)
      )
        throw new ConflictException('GIT_COPY_IN_USE');
    }

    // Keep the reservation and workspace on filesystem failure so retrying
    // deletion can discover the copy again, even if Codex already forgot it.
    await rm(target, { recursive: true, force: true });
    this.db.transaction((tx) => {
      tx.delete(projectWorkspaceResources)
        .where(eq(projectWorkspaceResources.id, workspace.id))
        .run();
      // Cascades to the copy, its reservation and its local location.
      tx.delete(projectWorkspaces)
        .where(eq(projectWorkspaces.id, workspace.id))
        .run();
    });
  }
}
