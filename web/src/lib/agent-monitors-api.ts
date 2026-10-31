import { projectsApi } from './projects-api';

export interface AgentMonitor {
  id: string;
  threadId: string;
  name: string;
  instructions: string;
  intervalMs: number | null;
  nextRunAt: number | null;
  expiresAt: number;
  maxRuns: number;
  maxRunMs: number;
  runCount: number;
  accessMode: 'readOnly' | 'workspaceWrite';
  status:
    | 'active'
    | 'paused'
    | 'completed'
    | 'expired'
    | 'exhausted'
    | 'needs_attention';
  lastReason: string | null;
}
export interface AgentMonitorRun {
  id: string;
  monitorId: string;
  turnId: string | null;
  status: string;
  claimedAt: number;
  finishedAt: number | null;
  result: string | null;
  reason: string | null;
  changed: boolean;
}
export interface MonitorListing {
  monitors: AgentMonitor[];
  activeRuns: AgentMonitorRun[];
}
export const monitorPath = (projectId: string, id?: string) =>
  `/${encodeURIComponent(projectId)}/agent-monitors${id ? `/${encodeURIComponent(id)}` : ''}`;
export const readMonitorHistory = (projectId: string, id: string) =>
  projectsApi<{ monitor: AgentMonitor; runs: AgentMonitorRun[] }>(
    monitorPath(projectId, id),
  );
