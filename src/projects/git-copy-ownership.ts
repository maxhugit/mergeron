import { ConflictException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import type { AppDatabase } from '../database/database.constants';
import {
  projectActiveFolders,
  projectAgentThreads,
  projectGitCopyOwners,
  projectWorkspaceCopies,
  projectWorkspaces,
  conversationBranchEdges,
} from '../database/schema';

const canonical = (value: string) => {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);

/** Edited-message versions are members of one work agent, not new agents. */
export function workAgentId(db: AppDatabase, threadId: string): string {
  return (
    db
      .select()
      .from(conversationBranchEdges)
      .where(eq(conversationBranchEdges.childThreadId, threadId))
      .get()?.treeRootThreadId ?? threadId
  );
}

export function copyAgentThreadIds(
  db: AppDatabase,
  projectId: string,
  copyId: string,
): string[] {
  const owners = copyAgentIds(db, projectId, copyId);
  return [
    ...new Set([
      ...owners,
      ...db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.projectId, projectId))
        .all()
        .filter((agent) => owners.includes(workAgentId(db, agent.threadId)))
        .map((agent) => agent.threadId),
    ]),
  ];
}

/** Includes legacy selections without rewriting or arbitrarily choosing an owner. */
export function copyAgentIds(
  db: AppDatabase,
  projectId: string,
  copyId: string,
  includeReservation = true,
): string[] {
  const copy = db
    .select()
    .from(projectWorkspaceCopies)
    .where(eq(projectWorkspaceCopies.id, copyId))
    .get();
  if (!copy || copy.projectId !== projectId) return [];
  const workspaces = db.select().from(projectWorkspaces).all();
  const root = workspaces.find((w) => w.id === copy.localWorkspaceId)?.path;
  if (!root) return [];
  const folders = db
    .select()
    .from(projectActiveFolders)
    .where(eq(projectActiveFolders.contextType, 'agent'))
    .all();
  const ids = db
    .select()
    .from(projectAgentThreads)
    .where(eq(projectAgentThreads.projectId, projectId))
    .all()
    .filter((agent) => {
      const folder = folders.find((f) => f.contextId === agent.threadId);
      const base =
        folder && workspaces.find((w) => w.id === folder.resourceId)?.path;
      const cwd = folder
        ? base
          ? path.resolve(base, folder.relativePath)
          : null
        : agent.workspacePath;
      return cwd && inside(canonical(root), canonical(cwd));
    })
    .map((agent) => agent.threadId);
  const owner = db
    .select()
    .from(projectGitCopyOwners)
    .where(eq(projectGitCopyOwners.copyId, copyId))
    .get();
  return [
    ...new Set([
      ...ids.map((id) => workAgentId(db, id)),
      ...(owner && includeReservation
        ? [workAgentId(db, owner.agentThreadId)]
        : []),
    ]),
  ];
}

export function assertAgentCanOwnCopy(
  db: AppDatabase,
  projectId: string,
  agentId: string,
  copyId?: string,
) {
  agentId = workAgentId(db, agentId);
  const existing = db
    .select()
    .from(projectGitCopyOwners)
    .where(eq(projectGitCopyOwners.agentThreadId, agentId))
    .get();
  if (existing && existing.copyId !== copyId)
    throw new ConflictException('GIT_AGENT_COPY_EXISTS');
  for (const copy of db
    .select()
    .from(projectWorkspaceCopies)
    .where(eq(projectWorkspaceCopies.projectId, projectId))
    .all()) {
    const ids = copyAgentIds(db, projectId, copy.id);
    if (copy.id === copyId && ids.some((id) => id !== agentId))
      throw new ConflictException('GIT_COPY_OWNED');
    if (copy.id !== copyId && ids.includes(agentId))
      throw new ConflictException('GIT_AGENT_COPY_EXISTS');
  }
}

export function claimAgentCopy(
  db: AppDatabase,
  projectId: string,
  agentId: string,
  copyId: string,
) {
  agentId = workAgentId(db, agentId);
  assertAgentCanOwnCopy(db, projectId, agentId, copyId);
  db.insert(projectGitCopyOwners)
    .values({
      copyId,
      agentThreadId: agentId,
      projectId,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  const saved = db
    .select()
    .from(projectGitCopyOwners)
    .where(
      and(
        eq(projectGitCopyOwners.copyId, copyId),
        eq(projectGitCopyOwners.agentThreadId, agentId),
      ),
    )
    .get();
  if (!saved) throw new ConflictException('GIT_COPY_OWNED');
}
