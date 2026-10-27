import type { ThreadStartResponseDto } from '@/generated/api';
import { projectsApi } from './projects-api';
/** A single request owns both creation and project membership, even if the UI closes. */
export function createProjectAgent({
  projectId,
  workspacePath,
}: {
  projectId: string;
  workspacePath: string;
}) {
  return projectsApi<ThreadStartResponseDto>(
    `/${encodeURIComponent(projectId)}/agents`,
    { method: 'POST', body: JSON.stringify({ workspacePath }) },
  );
}
