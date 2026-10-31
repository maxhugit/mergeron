import type { GitMergeChecks } from './workspace-git-api';

export type MergeCheckState =
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'running'
  | 'waiting'
  | 'unknown'
  | 'none';

const failures = new Set([
  'failure',
  'error',
  'timed_out',
  'action_required',
  'stale',
]);
const waiting = new Set(['pending', 'queued', 'requested', 'waiting']);

/** Missing, truncated or unfamiliar results must never become a green badge. */
export function mergeCheckState(
  checks: Pick<GitMergeChecks, 'items' | 'limited' | 'workflows'>,
): MergeCheckState {
  const statuses = [
    ...checks.items.map((item) => item.status),
    ...(checks.workflows?.items.map((item) => item.status) ?? []),
  ];
  if (statuses.some((status) => failures.has(status))) return 'failed';
  if (statuses.includes('in_progress')) return 'running';
  if (statuses.some((status) => waiting.has(status))) return 'waiting';
  if (statuses.includes('cancelled')) return 'cancelled';
  if (
    checks.limited ||
    checks.workflows?.limited ||
    checks.workflows?.available === false
  )
    return 'unknown';
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
  if (status === 'cancelled') return 'bg-muted text-foreground';
  if (status === 'running' || status === 'in_progress')
    return 'bg-violet-500/10 text-violet-700 dark:text-violet-300';
  if (status === 'waiting' || waiting.has(status))
    return 'bg-amber-500/10 text-amber-800 dark:text-amber-300';
  return 'bg-muted text-muted-foreground';
}
