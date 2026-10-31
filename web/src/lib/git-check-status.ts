import type { GitMergeChecks } from './workspace-git-api';

export type MergeCheckState =
  | 'passed'
  | 'failed'
  | 'running'
  | 'unknown'
  | 'none';

const failures = new Set([
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
]);
const running = new Set([
  'pending',
  'queued',
  'requested',
  'waiting',
  'in_progress',
]);

/** Missing, truncated or unfamiliar results must never become a green badge. */
export function mergeCheckState(
  checks: Pick<GitMergeChecks, 'items' | 'limited'>,
): MergeCheckState {
  const statuses = checks.items.map((item) => item.status);
  if (statuses.some((status) => failures.has(status))) return 'failed';
  if (statuses.some((status) => running.has(status))) return 'running';
  if (checks.limited) return 'unknown';
  if (!statuses.length) return 'none';
  if (
    statuses.includes('success') &&
    statuses.every((status) =>
      ['success', 'neutral', 'skipped'].includes(status),
    )
  )
    return 'passed';
  return 'unknown';
}

export function checkTone(status: string) {
  if (status === 'success' || status === 'passed')
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (failures.has(status) || status === 'failed')
    return 'bg-destructive/10 text-destructive';
  return 'bg-muted text-muted-foreground';
}
