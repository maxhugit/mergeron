import type { ProjectWorkspaceSummary } from './projects-api';
import { projectDirectorySelection } from './project-locations-api';

/** UI selection only; the server revalidates ownership and execution eligibility. */
export function localExecutionSelection(
  project: {
    workspaces: ReadonlyArray<Pick<ProjectWorkspaceSummary, 'id' | 'path'>>;
  },
  cwd: string,
) {
  // References may point to a deliverable or another nested project folder.
  // Preserve its relative path instead of requiring an exact workspace root.
  return projectDirectorySelection(project, cwd);
}
