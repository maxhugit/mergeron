import type { GitChecks } from './workspace-git-api';

export type GitPrStatus =
  | 'draft'
  | 'checking'
  | 'error'
  | 'conflict'
  | 'blocked'
  | 'ready'
  | 'unknown';
/** GitHub's clean mergeability is required; successful jobs alone do not imply approval. */
export function gitPrStatus(
  head: string,
  draft: boolean,
  checks?: GitChecks,
  failed = false,
): GitPrStatus {
  if (failed || !checks || checks.head !== head) return 'unknown';
  if (
    checks.items.some((c) =>
      [
        'failure',
        'error',
        'cancelled',
        'timed_out',
        'action_required',
        'stale',
        'startup_failure',
      ].includes(c.status),
    )
  )
    return 'error';
  if (checks.mergeable === false || checks.mergeableState === 'dirty')
    return 'conflict';
  if (draft || checks.draft) return 'draft';
  if (
    checks.items.some((c) =>
      ['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(
        c.status,
      ),
    )
  )
    return 'checking';
  if (
    checks.limited ||
    checks.items.some(
      (c) => !['success', 'neutral', 'skipped'].includes(c.status),
    )
  )
    return 'unknown';
  if (checks.mergeableState === 'blocked' || checks.mergeableState === 'behind')
    return 'blocked';
  if (
    checks.items.length > 0 &&
    checks.mergeable === true &&
    checks.mergeableState === 'clean'
  )
    return 'ready';
  return 'unknown';
}
