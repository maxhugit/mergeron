import type { ProjectWorkspaceSummary } from './projects-api';

/** UI selection only; the server revalidates ownership and execution eligibility. */
export function localExecutionSelection(
  project: {
    workspaces: ReadonlyArray<Pick<ProjectWorkspaceSummary, 'id' | 'path'>>;
  },
  cwd: string,
) {
  const location = project.workspaces.find(
    (workspace) => workspace.path === cwd,
  );
  return location
    ? { locationId: `local:${location.id}`, relativePath: '' }
    : null;
}
