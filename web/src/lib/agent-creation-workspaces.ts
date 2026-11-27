import type { ProjectWorkspaceSummary } from './projects-api';

/** Existing source copies are assigned explicitly after the new agent exists. */
export function agentCreationWorkspaces(
  workspaces: readonly ProjectWorkspaceSummary[] = [],
) {
  return workspaces.filter((workspace) => !workspace.sourceResourceId);
}
