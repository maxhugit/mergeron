/** Scoped team reads use the same session transport as the project interface. */
import { z } from 'zod';
import { projectsApi } from './projects-api';

const assignment = z.object({
  id: z.string(),
  role: z.string(),
  dependencies: z.array(z.string()),
  nativeThreadId: z.string().nullable(),
  status: z
    .enum(['planned', 'running', 'completed', 'failed', 'cancelled', 'unknown'])
    .catch('unknown'),
  updatedAt: z.number(),
});
const summary = z.object({
  id: z.string(),
  projectId: z.string(),
  coordinatorThreadId: z.string(),
  nativeTurnId: z.string().nullable(),
  origin: z.enum(['planned', 'observed']),
  objective: z.string(),
  createdAt: z.number(),
  assignments: z.array(assignment),
});
const listing = z.object({
  teams: z.array(summary),
  launchAvailable: z.boolean(),
});
const detail = summary.extend({
  assignments: z.array(
    assignment.extend({
      instructions: z.string(),
      result: z.string().nullable(),
    }),
  ),
});
export type AgentTeamSummary = z.infer<typeof summary>;
export type AgentTeamDetail = z.infer<typeof detail>;
export type TeamAssignment = AgentTeamSummary['assignments'][number];
export const teamPath = (projectId: string, teamId?: string) =>
  `/${encodeURIComponent(projectId)}/agent-teams${teamId ? '/' + encodeURIComponent(teamId) : ''}`;
export async function listAgentTeams(
  projectId: string,
  coordinator: string,
  signal?: AbortSignal,
) {
  return listing.parse(
    await projectsApi<unknown>(
      teamPath(projectId) + '?coordinator=' + encodeURIComponent(coordinator),
      { signal },
    ),
  );
}
export async function readAgentTeam(
  projectId: string,
  teamId: string,
  signal?: AbortSignal,
) {
  return detail.parse(
    await projectsApi<unknown>(teamPath(projectId, teamId), { signal }),
  );
}
export function assignmentState(
  assignment: TeamAssignment,
  assignments: TeamAssignment[],
) {
  if (assignment.status !== 'planned') return assignment.status;
  return assignment.dependencies.some(
    (id) => assignments.find((a) => a.id === id)?.status !== 'completed',
  )
    ? 'waiting'
    : 'planned';
}
