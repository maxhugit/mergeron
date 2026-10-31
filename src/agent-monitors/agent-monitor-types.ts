/** Limits bound unattended work; no monetary spending guarantee is implied. */
export const MONITOR_LIMITS = {
  minimumIntervalMs: 60_000,
  maximumLifetimeMs: 30 * 24 * 60 * 60_000,
  claimLeaseMs: 60_000,
  maximumActivePerProject: 20,
  maximumConcurrentRuns: 2,
  historyLimit: 100,
  maximumAgentRuns: 20,
  maximumAgentLifetimeMs: 24 * 60 * 60_000,
  maximumAgentRunMs: 300_000,
} as const;

export interface CreateAgentMonitor {
  requestId: string;
  name: string;
  instructions: string;
  runAt: number;
  /** null means one check; an interval runs after the previous check finishes. */
  intervalMs?: number | null;
  expiresAt: number;
  maxRuns?: number;
  maxRunMs?: number;
  accessMode?: 'readOnly' | 'workspaceWrite';
}

export interface MonitorOutcome {
  success: boolean;
  result: string;
  disposition?: 'continue' | 'complete' | 'attention';
  reason?: string;
}
