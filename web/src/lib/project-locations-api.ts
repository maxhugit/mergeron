import {
  projectsApi,
  type ProjectWorkspaceResourceSummary,
  type ProjectWorkspaceCopySummary,
  type ProjectSummary,
} from './projects-api';

export interface ProjectConnection {
  id: string;
  projectId: string;
  name: string;
  protocol: Exclude<ProjectWorkspaceResourceSummary['type'], 'local'>;
  address: string | null;
  enabled: boolean;
  connectionState: Exclude<
    ProjectWorkspaceResourceSummary['connectionState'],
    'local'
  >;
  lastCheckedAt: number | null;
  hasSecret: boolean;
}
export interface ProjectLocation {
  id: string;
  projectId: string;
  name: string;
  kind: 'managed_local' | 'attached_local' | 'remote';
  path: string;
  localWorkspaceId: string | null;
  connectionId: string | null;
  accessMode: 'read_only' | 'read_write';
  capabilities: ProjectWorkspaceResourceSummary['capabilities'];
  workingCopyId: string | null;
}
export interface ProjectLocationInventory {
  modelVersion: number;
  connections: ProjectConnection[];
  locations: ProjectLocation[];
  copies: Array<
    ProjectWorkspaceCopySummary & {
      locationId: string | null;
      sourceConnectionId: string | null;
    }
  >;
}
export const projectLocationsPath = (id: string) =>
  `/${encodeURIComponent(id)}/locations`;
export const projectConnectionsPath = (id: string) =>
  `/${encodeURIComponent(id)}/connections`;
export const locationTransfersPath = (id: string) =>
  `/${encodeURIComponent(id)}/location-transfers`;
export const getProjectLocations = (id: string, signal?: AbortSignal) =>
  projectsApi<ProjectLocationInventory>(projectLocationsPath(id), { signal });

/** Presentation adapters only: no old resource endpoint or permission fallback. */
export function locationResourceViews(
  inventory: ProjectLocationInventory,
): ProjectWorkspaceResourceSummary[] {
  return inventory.locations.flatMap((location) => {
    const connection = inventory.connections.find(
      (item) => item.id === location.connectionId,
    );
    if (location.kind === 'remote' && !connection) return [];
    const copy = inventory.copies.find(
      (item) => item.id === location.workingCopyId,
    );
    const enabled =
      connection?.enabled ??
      (!copy || (copy.state === 'ready' && copy.sourceEnabled));
    return [
      {
        id: location.id,
        projectId: location.projectId,
        localWorkspaceId: location.localWorkspaceId,
        name: location.name,
        type: connection?.protocol ?? 'local',
        address: connection?.address ?? null,
        rootPath: location.kind === 'remote' ? location.path : '/',
        accessMode:
          copy?.accessMode === 'read_only' ? 'read_only' : location.accessMode,
        capabilities: {
          ...location.capabilities,
          write:
            location.capabilities.write && copy?.accessMode !== 'read_only',
        },
        enabled,
        connectionState: connection?.connectionState ?? 'local',
        lastCheckedAt: connection?.lastCheckedAt ?? null,
        lastError: null,
        hasSecret: connection?.hasSecret ?? false,
        localPath: location.kind === 'remote' ? null : location.path,
      },
    ];
  });
}
export function connectionResourceViews(inventory: ProjectLocationInventory) {
  const views = locationResourceViews(inventory);
  return inventory.connections.flatMap((connection) => {
    const location = inventory.locations.find(
      (item) => item.connectionId === connection.id,
    );
    const view = views.find((item) => item.id === location?.id);
    return view ? [{ ...view, id: connection.id, name: connection.name }] : [];
  });
}

export function projectDirectorySelection(
  project: Pick<ProjectSummary, 'id' | 'workspaces'>,
  directory: string,
) {
  const workspace = [...(project.workspaces ?? [])]
    .filter(
      (item) =>
        directory === item.path ||
        directory.startsWith(item.path.replace(/\/+$/, '') + '/'),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!workspace) return null;
  const relativePath = directory
    .slice(workspace.path.replace(/\/+$/, '').length)
    .replace(/^\//, '');
  if (relativePath.split('/').some((part) => part === '..' || part === '.'))
    return null;
  return { locationId: `local:${workspace.id}`, relativePath };
}
