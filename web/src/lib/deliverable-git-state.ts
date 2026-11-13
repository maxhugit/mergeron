import type { Status } from './git-deliverables-api';
export type DeliverableGitState =
  | 'off'
  | 'noCopy'
  | 'checking'
  | 'syncing'
  | 'pending'
  | 'waiting'
  | 'review'
  | 'error'
  | 'ready'
  | 'readOnly'
  | 'excluded';
/** A previous successful timestamp is never evidence for the current branch. */
export function deliverableGitState(
  data: Status | undefined,
  copyId: string | undefined,
  itemId?: string,
  checking = false,
  failed = false,
): DeliverableGitState {
  if (failed) return 'error';
  if (!data) return 'checking';
  if (!data.boards.some((board) => board.settings?.enabled)) return 'off';
  const copy = data.copies.find((entry) => entry.id === copyId);
  if (!copy) return 'noCopy';
  const waiting =
    copy.lastError === 'GIT_BUSY' &&
    Boolean(
      copy.pending ||
      data.queued ||
      data.proposal?.changes.some((change) => change.action === 'export'),
    );
  if (checking)
    return waiting && !data.active && !data.discoveryError
      ? 'waiting'
      : 'checking';
  if (!copy.writable) return 'readOnly';
  if (!copy.eligible) return 'error';
  if (data.active) return 'syncing';
  if (
    data.discoveryError === 'GIT_DELIVERABLES_CHANGED' ||
    data.discoveryError === 'GIT_DELIVERABLES_BUSY'
  )
    return 'checking';
  if (data.discoveryError) return 'error';
  if (waiting) return 'waiting';
  // A successful comparison requiring review is not a transport/storage failure.
  // Keep real failures blocking even when a previous proposal remains cached.
  if (
    copy.lastError &&
    !['GIT_BUSY', 'GIT_DELIVERABLES_REVIEW_REQUIRED'].includes(copy.lastError)
  )
    return 'error';
  const proposal = data.proposal;
  if (
    !proposal ||
    !copy.context ||
    !proposal.context ||
    copy.context.branch !== proposal.context.branch ||
    copy.context.head !== proposal.context.head
  )
    return copy.pending || data.queued ? 'pending' : 'checking';
  const changes = proposal.changes.filter(
    (change) =>
      !itemId || !change.deliverableId || change.deliverableId === itemId,
  );
  if (
    changes.some((change) =>
      ['conflict', 'import', 'rename'].includes(change.action),
    )
  )
    return 'review';
  if (
    copy.pending ||
    data.queued ||
    changes.some((change) => change.action === 'export')
  )
    return 'pending';
  if (changes.some((change) => change.action === 'excluded')) return 'excluded';
  return 'ready';
}

/** A blocked sibling never changes the status of this document's verified bytes. */
export function documentGitState(
  data: Status | undefined,
  copyId: string | undefined,
  itemId: string,
  documentId: string,
  name: string,
  checking = false,
  failed = false,
): DeliverableGitState {
  const overall = deliverableGitState(data, copyId, itemId, checking, failed);
  if (
    !data ||
    [
      'off',
      'noCopy',
      'checking',
      'syncing',
      'waiting',
      'error',
      'readOnly',
      'excluded',
    ].includes(overall)
  )
    return overall;
  const copy = data.copies.find((copy) => copy.id === copyId);
  const proposal = data.proposal;
  if (
    !proposal ||
    !copy?.context ||
    proposal.context?.branch !== copy.context.branch ||
    proposal.context?.head !== copy.context.head
  )
    return overall;
  const changes = proposal.changes.filter(
    (change) =>
      change.deliverableId === itemId &&
      (change.documentId === documentId ||
        (!change.documentId && change.document === name)),
  );
  const structural = proposal.changes.some(
    (change) =>
      change.action === 'conflict' &&
      !change.document &&
      (!change.deliverableId ||
        (change.deliverableId === itemId &&
          !['metadata_baseline_missing', 'metadata_changed_both'].includes(
            change.reason,
          ))),
  );
  if (structural || changes.some((change) => change.action === 'conflict'))
    return 'error';
  if (changes.some((change) => ['import', 'rename'].includes(change.action)))
    return 'review';
  if (changes.some((change) => change.action === 'export')) return 'pending';
  return 'ready';
}
