import {
  projectsApi,
  type ProjectWorkspaceCopySummary,
  type ProjectWorkspaceResourceSummary,
} from './projects-api';

export interface GitInventory {
  resources: ProjectWorkspaceResourceSummary[];
  copies: ProjectWorkspaceCopySummary[];
}

export function copyOwnedByAgent(
  copy: ProjectWorkspaceCopySummary,
  agentId: string | undefined,
): boolean {
  return Boolean(
    agentId &&
    copy.ownerAgentIds?.length === 1 &&
    (copy.ownerThreadIds ?? copy.ownerAgentIds).includes(agentId),
  );
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

export interface GitRemoteBranches {
  supported: boolean;
  limited: boolean;
  inspectedAt: number;
  items: Array<{ name: string; revision: string; protected: boolean }>;
}
export interface GitCommits {
  limited: boolean;
  items: Array<{ sha: string; date: string; author: string; subject: string }>;
}
export interface GitGraph {
  limited: boolean;
  inspectedAt: number;
  items: Array<{
    sha: string;
    parents: string[];
    date: string;
    author: string;
    subject: string;
    current: boolean;
    refs: Array<{ name: string; remote: boolean }>;
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
  stagedOnly?: boolean;
}

export const gitInventoryKey = (projectId: string) =>
  ['workspace-git-inventory', projectId] as const;
export const gitPath = (projectId: string, suffix: string) =>
  `/${encodeURIComponent(projectId)}/git/${suffix.replace(/^resources\//, 'connections/')}`;
export const gitGet = <T>(
  projectId: string,
  suffix: string,
  signal?: AbortSignal,
) => projectsApi<T>(gitPath(projectId, suffix), { signal });
