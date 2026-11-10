/** Standalone human interventions retain their point inside the assistant turn. */
import type { ApprovalRequest, UserInputRequest } from '@/types/approval';
import type { TimelineEntry } from '@/types/timeline';
import { pendingRequestKey } from './pending-request-identity';
import { responseBoundary } from './conversation-segments';

function ensureRequestEntry(
  timeline: TimelineEntry[],
  request: ApprovalRequest | UserInputRequest,
  userInput: boolean,
  fallbackTurnId?: string | null,
): TimelineEntry[] {
  const instanceId = pendingRequestKey(request);
  if (
    timeline.some(
      (entry) =>
        entry.kind === 'interaction' && entry.instanceId === instanceId,
    )
  )
    return timeline;
  const turnId =
    request.turnId ??
    fallbackTurnId ??
    timeline.findLast((row) => row.kind === 'turn' && !row.completed)?.turnId;
  if (
    turnId &&
    !timeline.some((row) => row.kind === 'turn' && row.turnId === turnId)
  ) {
    timeline = [
      ...timeline,
      { kind: 'turn', turnId, items: [], completed: false },
    ];
  }
  const turn = timeline.find(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );
  const items = turn?.kind === 'turn' ? turn.items : [];
  const requestIndex = items.findIndex(
    (item) => item.itemId === request.itemId,
  );
  const entry: TimelineEntry = {
    kind: 'interaction',
    requestId: String(request.requestId),
    instanceId,
    ...(userInput && { userInput: true }),
    ...(turnId && {
      turnId,
      responseBoundary: responseBoundary(
        requestIndex >= 0 ? items.slice(0, requestIndex + 1) : items,
      ),
    }),
  };
  const result = [...timeline];
  const last = turnId
    ? result.findLastIndex((row) => row.turnId === turnId)
    : -1;
  result.splice(last >= 0 ? last + 1 : result.length, 0, entry);
  return result;
}

export function ensureInteractionEntry(
  timeline: TimelineEntry[],
  request: ApprovalRequest,
  fallbackTurnId?: string | null,
): TimelineEntry[] {
  return ensureRequestEntry(timeline, request, false, fallbackTurnId);
}

export function ensureUserInputEntry(
  timeline: TimelineEntry[],
  request: UserInputRequest,
): TimelineEntry[] {
  return ensureRequestEntry(timeline, request, true);
}
