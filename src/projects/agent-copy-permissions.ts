/** Native filesystem profiles: a writable project root never grants sibling copies. */
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { AppDatabase } from '../database/database.constants';
import {
  projectWorkspaceCopies,
  projectWorkspaces,
  projectLocations,
  projectConnections,
} from '../database/schema';
import { copyAgentIds, workAgentId } from './git-copy-ownership';

export interface CopyPermissionProfiles {
  writable: string;
  readOnly: string;
  config: Record<string, unknown>;
  writableCopyPath: string | null;
  readOnlyRoots: string[];
}
const canonical = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    throw new ConflictException('GIT_COPY_PATH_UNSAFE');
  }
};

/** Include the container directory, so copies created during a turn are covered too. */
export function agentCopyPermissions(
  db: AppDatabase,
  projectId: string,
  threadId: string | undefined,
  baseProfile = ':workspace',
  pendingCwd?: string | null,
): CopyPermissionProfiles {
  const workspaces = db.select().from(projectWorkspaces).all();
  const filesystem: Record<string, 'read' | 'write'> = {};
  for (const workspace of workspaces.filter((workspace) => workspace.primary)) {
    const root = canonical(workspace.path);
    // Protect lexical and physical names, including symlinked primary workspaces.
    for (const location of new Set([path.resolve(workspace.path), root]))
      filesystem[path.join(location, 'sources', '.external')] = 'read';
  }
  const locations = db.select().from(projectLocations).all();
  const connections = db.select().from(projectConnections).all();
  const agentId = threadId ? workAgentId(db, threadId) : null;
  let ownCount = 0;
  let writableCopyPath: string | null = null;
  for (const copy of db.select().from(projectWorkspaceCopies).all()) {
    const workspace = workspaces.find(
      (workspace) => workspace.id === copy.localWorkspaceId,
    );
    if (!workspace) throw new ConflictException('GIT_COPY_PATH_UNSAFE');
    const physical = canonical(workspace.path);
    // Legacy copies outside sources/.external are protected explicitly as well.
    filesystem[path.resolve(workspace.path)] = 'read';
    filesystem[physical] = 'read';
    if (copy.projectId !== projectId) continue;
    const owners = copyAgentIds(db, projectId, copy.id);
    // No turn can run before the new thread is bound. Its prospective cwd may
    // reserve an unowned copy after start, without changing the native profile.
    const pending =
      !agentId &&
      pendingCwd &&
      owners.length === 0 &&
      (canonical(pendingCwd) === physical ||
        canonical(pendingCwd).startsWith(physical + path.sep));
    if (!(agentId && owners.includes(agentId)) && !pending) continue;
    if (!pending && owners.length !== 1)
      throw new ConflictException('GIT_COPY_OWNED');
    if (++ownCount > 1) throw new ConflictException('GIT_AGENT_COPY_EXISTS');
    if (copy.state !== 'ready')
      throw new ConflictException('GIT_COPY_PATH_UNSAFE');
    const source = locations.find(
      (location) =>
        location.projectId === projectId &&
        location.legacyResourceId === copy.sourceResourceId &&
        location.kind === 'remote',
    );
    const local = locations.find(
      (location) => location.localWorkspaceId === copy.localWorkspaceId,
    );
    const connection = connections.find(
      (connection) => connection.id === source?.connectionId,
    );
    if (
      !connection?.enabled ||
      !source?.capabilities.read ||
      !local?.capabilities.read
    )
      throw new ConflictException('PROJECT_CONNECTION_UNAVAILABLE');
    if (
      source.accessMode !== 'read_write' ||
      !source.capabilities.write ||
      local.accessMode !== 'read_write' ||
      !local.capabilities.write
    )
      continue;
    if (baseProfile !== ':workspace') continue;
    writableCopyPath = physical;
    filesystem[physical] = 'write';
    filesystem[path.resolve(workspace.path)] = 'write';
  }
  const stable = Object.fromEntries(
    Object.entries(filesystem).sort(([a], [b]) => a.localeCompare(b)),
  );
  const key = createHash('sha256')
    .update(JSON.stringify({ baseProfile, filesystem: stable }))
    .digest('hex')
    .slice(0, 24);
  const writable = `mergeron_copy_${key}`;
  const readOnly = `${writable}_read`;
  return {
    writable,
    readOnly,
    writableCopyPath,
    readOnlyRoots: Object.entries(stable)
      .filter(([, access]) => access === 'read')
      .map(([root]) => root),
    config: {
      [writable]: { extends: baseProfile, filesystem: stable },
      [readOnly]: {
        extends: ':read-only',
        filesystem: Object.fromEntries(
          Object.keys(stable).map((root) => [root, 'read']),
        ),
      },
    },
  };
}

/** Older engines must fail before a model turn, never silently ignore the boundary. */
export function assertCopyPermissionProfile(
  expected: string | undefined,
  response: unknown,
): void {
  if (!expected) return;
  const profile = (
    response as { activePermissionProfile?: { id?: unknown } } | null
  )?.activePermissionProfile;
  if (profile?.id !== expected)
    throw new ConflictException('GIT_COPY_ISOLATION_UNAVAILABLE');
}
