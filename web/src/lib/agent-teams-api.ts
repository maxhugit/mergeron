/** Scoped team reads use the same session transport as the project interface. */
import { z } from 'zod';
import { projectsApi } from './projects-api';
import type { PendingServerRequestDto } from '@/generated/api';

const assignment = z.object({
  id: z.string(),
  role: z.string(),
  taskId: z.string().nullable().default(null),
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
  state: z
    .enum([
      'observed',
      'draft',
      'preparing',
      'dispatching',
      'running',
      'completed',
      'failed',
      'stopping',
      'stopped',
      'unknown',
      'needs_attention',
    ])
    .default('observed'),
  lastError: z.string().nullable().default(null),
  objective: z.string(),
  deliverableId: z.string().nullable().default(null),
  createdAt: z.number(),
  assignments: z.array(assignment),
});
const listing = z.object({
  teams: z.array(summary),
  launchAvailable: z.boolean(),
});
const detail = summary.extend({
  summary: z.string().nullable().default(null),
  canRespond: z.boolean().default(false),
  requests: z.array(z.custom<PendingServerRequestDto>()).default([]),
  attention: z
    .array(
      z.object({
        threadId: z.string(),
        status: z.string(),
        kind: z.enum(['approval', 'question']),
      }),
    )
    .default([]),
  controlsLimited: z.boolean().default(false),
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
export async function controlAgentTeam(
  projectId: string,
  teamId: string,
  action: 'stop' | 'reconcile',
) {
  return detail.parse(
    await projectsApi<unknown>(teamPath(projectId, teamId) + '/' + action, {
      method: 'POST',
    }),
  );
}
const history = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(['agent', 'user']),
      text: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export async function readTeamHistory(
  projectId: string,
  teamId: string,
  assignmentId: string,
  cursor: string | null,
  signal?: AbortSignal,
) {
  return history.parse(
    await projectsApi<unknown>(
      teamPath(projectId, teamId) +
        '/assignments/' +
        encodeURIComponent(assignmentId) +
        '/history' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      { signal },
    ),
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
const profileSchema = z.object({
  key: z.string(),
  role: z.string(),
  instructions: z.string(),
  dependencies: z.array(z.string()),
});
export type TeamProfile = z.infer<typeof profileSchema>;
export async function readTeamProfiles(
  projectId: string,
  coordinator: string,
  signal?: AbortSignal,
) {
  return z
    .array(profileSchema)
    .parse(
      await projectsApi<unknown>(
        teamPath(projectId, 'profiles') +
          '?coordinator=' +
          encodeURIComponent(coordinator),
        { signal },
      ),
    );
}
export async function saveTeamProfiles(
  projectId: string,
  coordinator: string,
  profiles: TeamProfile[],
) {
  return z
    .array(profileSchema)
    .parse(
      await projectsApi<unknown>(
        teamPath(projectId, 'profiles') +
          '?coordinator=' +
          encodeURIComponent(coordinator),
        { method: 'PUT', body: JSON.stringify(profiles) },
      ),
    );
}
export async function prepareAgentTeam(
  projectId: string,
  coordinator: string,
  input: { requestId: string; objective: string; profiles: TeamProfile[] },
) {
  return detail.parse(
    await projectsApi<unknown>(
      teamPath(projectId, 'prepare') +
        '?coordinator=' +
        encodeURIComponent(coordinator),
      { method: 'POST', body: JSON.stringify(input) },
    ),
  );
}
export async function launchAgentTeam(projectId: string, teamId: string) {
  return detail.parse(
    await projectsApi<unknown>(teamPath(projectId, teamId) + '/launch', {
      method: 'POST',
    }),
  );
}

const businessContext = z.object({
  boards: z.array(z.object({ id: z.string(), name: z.string() })),
  deliverables: z.array(z.object({ id: z.string(), title: z.string() })),
  tasks: z.array(
    z.object({ id: z.string(), title: z.string(), resourceId: z.string() }),
  ),
  truncated: z.boolean(),
});
export async function readTeamContext(
  projectId: string,
  coordinator: string,
  signal?: AbortSignal,
) {
  return businessContext.parse(
    await projectsApi<unknown>(
      teamPath(projectId, 'context') +
        '?coordinator=' +
        encodeURIComponent(coordinator),
      { signal },
    ),
  );
}
export async function saveTeamLinks(
  projectId: string,
  teamId: string,
  links: {
    deliverableId: string | null;
    assignments: Array<{ id: string; taskId: string | null }>;
  },
) {
  return detail.parse(
    await projectsApi<unknown>(teamPath(projectId, teamId) + '/links', {
      method: 'PUT',
      body: JSON.stringify(links),
    }),
  );
}
export async function createTaskFromContribution(
  projectId: string,
  teamId: string,
  assignmentId: string,
  input: {
    confirmed: true;
    resourceId: string;
    title: string;
    description: string;
  },
) {
  return z
    .object({ id: z.string() })
    .parse(
      await projectsApi<unknown>(
        teamPath(projectId, teamId) +
          '/assignments/' +
          encodeURIComponent(assignmentId) +
          '/task',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    );
}
const contributionList = z.object({
  teams: z.array(
    z.object({
      id: z.string(),
      coordinatorThreadId: z.string(),
      objective: z.string(),
      state: z.string(),
      assignments: z.array(
        z.object({
          id: z.string(),
          role: z.string(),
          status: z.string(),
          result: z.string().nullable(),
        }),
      ),
    }),
  ),
});
export async function readTeamContributions(
  projectId: string,
  target: { taskId: string } | { deliverableId: string },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams(target);
  return contributionList.parse(
    await projectsApi<unknown>(
      teamPath(projectId, 'contributions') + '?' + query.toString(),
      { signal },
    ),
  );
}
