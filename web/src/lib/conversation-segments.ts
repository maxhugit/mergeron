/** Presentation fragments keep one protocol turn while allowing human interjections. */
import type {
  ResponseBoundary,
  TimelineEntry,
  TurnItem,
} from '@/types/timeline';

type TurnEntry = Extract<TimelineEntry, { kind: 'turn' }>;
type BoundaryEntry = Extract<TimelineEntry, { kind: 'user' | 'interaction' }>;

export function responseBoundary(items: TurnItem[]): ResponseBoundary {
  return {
    items: Object.fromEntries(
      items.map((item) => [
        item.itemId,
        item.type === 'agentMessage' || item.type === 'reasoning'
          ? item.content.length
          : 0,
      ]),
    ),
  };
}

export function captureResponseBoundary(
  timeline: TimelineEntry[],
  turnId: string,
): ResponseBoundary {
  const turn = timeline.find(
    (entry): entry is TurnEntry =>
      entry.kind === 'turn' && entry.turnId === turnId,
  );
  return responseBoundary(turn?.items ?? []);
}

function boundaryKey(entry: BoundaryEntry): string {
  return entry.kind === 'interaction'
    ? entry.instanceId
    : (entry.localId ?? entry.itemId ?? '');
}

/** Splits prose by captured offsets, never duplicating tool calls or requests. */
function fragments(turn: TurnEntry, boundaries: BoundaryEntry[]): TurnEntry[] {
  const groups: TurnItem[][] = Array.from(
    { length: boundaries.length + 1 },
    () => [],
  );
  for (const item of turn.items) {
    const cuts = boundaries.map((row) =>
      Object.hasOwn(row.responseBoundary!.items, item.itemId)
        ? row.responseBoundary!.items[item.itemId]
        : undefined,
    );
    if (item.type !== 'agentMessage' && item.type !== 'reasoning') {
      const first = cuts.findIndex((cut) => cut !== undefined);
      groups[first < 0 ? boundaries.length : first].push(item);
      continue;
    }
    let start = 0;
    for (let index = 0; index <= boundaries.length; index++) {
      const end =
        index === boundaries.length
          ? item.content.length
          : Math.max(start, Math.min(item.content.length, cuts[index] ?? 0));
      const owner = cuts.findIndex((cut) => cut !== undefined);
      const ownsQuestions = index === (owner < 0 ? boundaries.length : owner);
      if (
        end > start ||
        (item.type === 'agentMessage' && ownsQuestions && item.questions.length)
      ) {
        groups[index].push({
          ...item,
          content: item.content.slice(start, end),
          ...(item.type === 'agentMessage' &&
            !ownsQuestions && { questions: [] }),
        });
      }
      start = end;
    }
  }
  return groups.map((items, index) => ({
    ...turn,
    items,
    ...(index < boundaries.length && { plan: undefined, diff: undefined }),
    presentation: {
      key:
        index === 0
          ? 'start'
          : `after:${boundaryKey(boundaries[index - 1]) || index}`,
      last: index === boundaries.length,
    },
  }));
}

/** Runtime history remains canonical; only the rendered transcript is segmented. */
export function projectConversationTimeline(
  timeline: TimelineEntry[],
): TimelineEntry[] {
  const boundaries = new Map<string, BoundaryEntry[]>();
  for (const row of timeline) {
    if (
      (row.kind !== 'user' && row.kind !== 'interaction') ||
      !row.turnId ||
      !row.responseBoundary
    )
      continue;
    const rows = boundaries.get(row.turnId) ?? [];
    rows.push(row);
    boundaries.set(row.turnId, rows);
  }
  const first = new Map<string, TurnEntry>();
  const after = new Map<TimelineEntry, TurnEntry>();
  for (const row of timeline) {
    if (row.kind !== 'turn') continue;
    const cuts = boundaries.get(row.turnId);
    if (!cuts?.length) continue;
    const parts = fragments(row, cuts);
    first.set(row.turnId, parts[0]);
    cuts.forEach((cut, index) => after.set(cut, parts[index + 1]));
  }
  return timeline.flatMap((row) => [
    row.kind === 'turn' ? (first.get(row.turnId) ?? row) : row,
    ...(after.has(row) ? [after.get(row)!] : []),
  ]);
}
