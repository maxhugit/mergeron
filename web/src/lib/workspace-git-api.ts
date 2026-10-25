import {
  projectsApi,
  type ProjectWorkspaceCopySummary,
  type ProjectWorkspaceResourceSummary,
} from './projects-api';

export interface GitInventory {
  resources: ProjectWorkspaceResourceSummary[];
  copies: ProjectWorkspaceCopySummary[];
}
export interface GitSnapshot {
  fingerprint?: string;
  branch: string | null;
  head: string;
  ahead: number;
  behind: number;
  upstream: string | null;
  inspectedAt: number;
  branchesLimited: boolean;
  changes: Array<{ path: string; originalPath?: string; status: string }>;
  branches: Array<{
    name: string;
    revision: string;
    remote: boolean;
    upstream: string;
    tracking: string;
  }>;
}
export interface GitPullRequests {
  supported: boolean;
  limited: boolean;
  items: Array<{
    number: number;
    title: string;
    draft: boolean;
    branch: string;
    base: string;
    head: string;
    url: string;
  }>;
}
export interface GitChecks {
  baseHead?: string | null;
  head: string;
  mergeable: boolean | null;
  mergeableState: string;
  draft: boolean;
  limited: boolean;
  inspectedAt: number;
  items: Array<{ id: string; name: string; status: string }>;
}
export interface GitDiff {
  path: string;
  diff: string;
  untracked: boolean;
}

export const gitInventoryKey = (projectId: string) =>
  ['workspace-git-inventory', projectId] as const;
export const gitPath = (projectId: string, suffix: string) =>
  `/${encodeURIComponent(projectId)}/workspace-git/${suffix}`;
export const gitGet = <T>(
  projectId: string,
  suffix: string,
  signal?: AbortSignal,
) => projectsApi<T>(gitPath(projectId, suffix), { signal });
