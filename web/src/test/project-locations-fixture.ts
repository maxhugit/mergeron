import type { GitInventory } from '@/lib/workspace-git-api';
import type { ProjectLocationInventory } from '@/lib/project-locations-api';

/** Convert historical test fixtures to the normalized wire contract. */
export function locationInventoryFixture(
  input: GitInventory,
): ProjectLocationInventory {
  return {
    modelVersion: 1,
    connections: input.resources
      .filter((r) => r.type !== 'local')
      .map((r) => ({
        id: r.id,
        projectId: r.projectId,
        name: r.name,
        protocol: r.type as 'git',
        address: r.address,
        enabled: r.enabled,
        connectionState: r.connectionState as 'connected',
        lastCheckedAt: r.lastCheckedAt,
        hasSecret: r.hasSecret,
      })),
    locations: input.resources.map((r) => ({
      id: r.type === 'local' ? `local:${r.localWorkspaceId}` : `remote:${r.id}`,
      projectId: r.projectId,
      name: r.name,
      kind: r.type === 'local' ? 'attached_local' : 'remote',
      path: r.type === 'local' ? r.localPath! : (r.rootPath ?? '/'),
      localWorkspaceId: r.localWorkspaceId,
      connectionId: r.type === 'local' ? null : r.id,
      accessMode: r.accessMode,
      capabilities: r.capabilities ?? {
        read: true,
        write: r.accessMode === 'read_write',
        execute: false,
      },
      workingCopyId: null,
    })),
    copies: input.copies.map((copy) => ({
      ...copy,
      locationId: `local:${copy.localWorkspaceId}`,
      sourceConnectionId: copy.sourceResourceId,
    })),
  };
}
