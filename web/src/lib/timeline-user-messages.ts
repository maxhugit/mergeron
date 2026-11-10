import { captureResponseBoundary } from './conversation-segments';
import type { ResponseBoundary, TimelineEntry } from '@/types/timeline';
import type { NormalizedUserMessage } from './thread-item-normalizer';

export type UserEntry = Extract<TimelineEntry, { kind: 'user' }>;

export function sameUserMessage(a: UserEntry, b: UserEntry): boolean {
  return (
    a.content === b.content &&
    JSON.stringify(a.images ?? []) === JSON.stringify(b.images ?? [])
  );
}

/** Native echoes settle one optimistic occurrence, not every identical instruction. */
export function upsertTimelineUserMessage(
  timeline: TimelineEntry[],
  turnId: string,
  message: NormalizedUserMessage,
  boundary?: ResponseBoundary,
): TimelineEntry[] {
  const incoming: UserEntry = {
    kind: 'user',
    turnId,
    content: message.text,
    ...(message.itemId && { itemId: message.itemId }),
    ...(message.images.length && { images: message.images }),
  };
  let index = message.itemId
    ? timeline.findIndex(
        (entry) =>
          entry.kind === 'user' &&
          entry.turnId === turnId &&
          entry.itemId === message.itemId,
      )
    : -1;
  if (index < 0)
    index = timeline.findIndex(
      (entry) =>
        entry.kind === 'user' &&
        !entry.itemId &&
        entry.turnId === turnId &&
        sameUserMessage(entry, incoming),
    );
  // A first prompt may be shown using its editable text rather than the
  // attachment-enriched wire input. Only the unconfirmed original can match it.
  if (
    index < 0 &&
    !timeline.some(
      (entry) =>
        entry.kind === 'user' &&
        entry.turnId === turnId &&
        entry.itemId &&
        !entry.steering,
    )
  )
    index = timeline.findIndex(
      (entry) =>
        entry.kind === 'user' &&
        !entry.itemId &&
        !entry.steering &&
        (entry.turnId === turnId ||
          (entry.turnId === undefined && sameUserMessage(entry, incoming))),
    );
  if (index >= 0) {
    const previous = timeline[index] as UserEntry;
    const next = [...timeline];
    next[index] = {
      ...previous,
      turnId,
      ...(message.itemId && { itemId: message.itemId }),
    };
    return next;
  }
  const steering = timeline.some(
    (entry) => entry.kind === 'user' && entry.turnId === turnId,
  );
  const next = [...timeline];
  const turnIndex = next.findIndex(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );
  if (!steering && turnIndex >= 0) next.splice(turnIndex, 0, incoming);
  else {
    // Recovery may discover a steering message after later turns were already
    // rendered. Keep it inside its own turn rather than appending it after an
    // unrelated conversation exchange.
    const lastTurnIndex = next.findLastIndex(
      (entry) => entry.kind !== 'system' && entry.turnId === turnId,
    );
    const failureIndex = next.findIndex(
      (entry) => entry.kind === 'turnFailure' && entry.turnId === turnId,
    );
    const index =
      failureIndex >= 0
        ? failureIndex
        : lastTurnIndex >= 0
          ? lastTurnIndex + 1
          : next.length;
    next.splice(index, 0, {
      ...incoming,
      ...(steering && {
        steering: true,
        responseBoundary: boundary ?? captureResponseBoundary(timeline, turnId),
      }),
    });
  }
  return next;
}
