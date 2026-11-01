import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface ProjectAgentThreadSummary {
  threadId: string;
  workspacePath: string;
  activeFolder: ActiveFolderSummary | null;
  title: string;
  archived: boolean;
  archivedAt?: number | null;
  archivedByPersonId?: string | null;
  archivedByName?: string | null;
  archivedByType?: 'person' | 'service' | 'system' | null;
  taskId: string | null;
  taskResourceId: string | null;
  taskTitle: string | null;
  isSubtask: boolean;
}

export interface ProjectSummary {
  browserSettings?: {
    homeUrl: string;
    desktopSplit: boolean;
    allowPopups: boolean;
  };
  id: string;
  name: string;
  workspacePath: string;
  systemWorkspacePath?: string;
  createdAt: number;
  updatedAt: number;
  mcpServerIds?: string[];
  appIds?: string[];
  agentModel?: string | null;
  agentReasoningEffort?: string | null;
  sidebarOrder?: string[];
  workspaces: ProjectWorkspaceSummary[];
  resources: ProjectResourceSummary[];
  agentThreads?: ProjectAgentThreadSummary[];
}

export interface ProjectActivitySummary {
  id: string;
  projectId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  label: string;
  details: Record<string, unknown>;
  actorPersonId: string | null;
  actorName: string;
  createdAt: number;
}

export interface ProjectResourceSummary {
  id: string;
  projectId: string;
  type: 'task_board' | 'automation_board' | 'deliverable_board';
  name: string;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  taskCount?: number;
}

export interface ProjectTaskStatusSummary {
  id: string;
  resourceId: string;
  name: string;
  color: string;
  kind: string;
  position: number;
  system: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectTaskSummary {
  assigneeId: string | null;
  id: string;
  resourceId: string;
  statusId: string;
  title: string;
  description: string;
  priority: string;
  parentTaskId: string | null;
  subtaskStatus: 'todo' | 'started' | 'review' | 'done' | 'cancelled';
  workspacePath: string | null;
  activeFolder?: ActiveFolderSummary | null;
  executionMode: 'manual' | 'agent';
  agentState:
    | 'manual'
    | 'ready'
    | 'running'
    | 'waiting'
    | 'error'
    | 'review'
    | 'validated';
  estimateMinutes: number;
  progress: number;
  startAt: number | null;
  dueAt: number | null;
  validationCriteria: string;
  labels: string[];
  linkedThreadId: string | null;
  linkedSimpleChatId: string | null;
  linkedFilePath: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectTaskBoard {
  resource: ProjectResourceSummary;
  project: Pick<ProjectSummary, 'id' | 'name' | 'workspacePath'>;
  workspaces: ProjectWorkspaceSummary[];
  statuses: ProjectTaskStatusSummary[];
  tasks: ProjectTaskSummary[];
  activity: ProjectTaskActivitySummary[];
  dependencies: Array<{
    taskId: string;
    dependsOnTaskId: string;
    createdAt: number;
  }>;
}

export interface ProjectTaskActivitySummary {
  id: string;
  resourceId: string;
  taskId: string;
  taskTitle: string;
  parentTaskId: string | null;
  action: 'created' | 'updated' | 'deleted';
  changes: Record<string, { before: unknown; after: unknown }>;
  actorPersonId: string | null;
  actorName: string;
  createdAt: number;
}

export interface ProjectWorkspaceSummary {
  id: string;
  projectId: string;
  name: string;
  path: string;
  primary: boolean;
  readOnly?: boolean;
  sourceResourceId?: string | null;
  branch?: string | null;
  revision?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkspaceResourceSummary {
  id: string;
  projectId: string;
  localWorkspaceId: string | null;
  name: string;
  type: 'local' | 'git' | 'ssh' | 'sftp' | 'ftp' | 'ftps';
  address: string | null;
  rootPath: string;
  accessMode: 'read_only' | 'read_write';
  capabilities: { read: boolean; write: boolean; execute: false };
  enabled: boolean;
  connectionState:
    | 'local'
    | 'untested'
    | 'connected'
    | 'unreachable'
    | 'disabled';
  lastCheckedAt: number | null;
  lastError: string | null;
  hasSecret: boolean;
  localPath: string | null;
}

export interface ProjectWorkspaceCopySummary {
  ownerAgentIds?: string[];
  ownerThreadIds?: string[];
  id: string;
  projectId: string;
  sourceResourceId: string;
  localWorkspaceId: string;
  name: string;
  branch: string | null;
  revision: string;
  state: 'ready' | 'revoked' | 'error';
  lastError: string | null;
  localPath: string | null;
  sourceName: string | null;
  sourceType: string | null;
  accessMode: 'read_only' | 'read_write' | null;
  sourceEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkspaceTransferSummary {
  id: string;
  projectId: string;
  name: string;
  sourceResourceId: string;
  destinationWorkspaceId: string;
  sourcePath: string;
  destinationPath: string;
  exclusions: string[];
  conflictPolicy: 'skip' | 'overwrite';
  propagateDeletes: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkspaceTransferRunSummary {
  id: string;
  projectId: string;
  transferId: string;
  status:
    | 'previewed'
    | 'running'
    | 'success'
    | 'completed_with_conflicts'
    | 'error';
  planHash: string;
  changes: Array<{
    path: string;
    action: 'create' | 'update' | 'conflict' | 'delete' | 'unchanged';
    size: number;
    sourceHash: string | null;
    destinationHash: string | null;
  }>;
  summary: Record<string, number>;
  error: string | null;
  actorName: string;
  startedAt: number;
  finishedAt: number | null;
}

export interface ActiveFolderSummary {
  contextType: 'agent' | 'simple_chat' | 'task' | 'deliverable';
  contextId: string;
  projectId: string;
  resourceId: string;
  resourceName: string | null;
  relativePath: string;
  effectivePath: string | null;
  state: 'ready' | 'detached' | 'missing' | 'invalid' | 'revoked';
}

export const projectsQueryKey = ['projects'] as const;

/** Finds the project owning an exact conversation workspace path. */
export function projectForWorkspace(
  projects: readonly ProjectSummary[] | undefined,
  cwd: string | null,
): ProjectSummary | undefined {
  if (!cwd) return undefined;
  return projects?.find((project) =>
    project.workspaces.some(
      (workspace) =>
        workspace.path === cwd || cwd.startsWith(`${workspace.path}/`),
    ),
  );
}

export async function projectsApi<T>(
  path = '',
  init?: RequestInit,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/projects${path}`), {
    ...init,
    headers: {
      ...(init?.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(authorization ? { Authorization: authorization } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    message?: string;
  };
  if (!response.ok)
    throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}
