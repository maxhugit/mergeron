import type { ProjectSummary } from '@/lib/projects-api';

/** Only Mergeron's reserved directory at the managed primary root is internal. */
export function projectSystemDirectory(project?: ProjectSummary) {
  const primary = project?.workspaces?.find((workspace) => workspace.primary);
  return primary ? `${primary.path.replace(/\/+$/, '')}/.mergeron` : undefined;
}
