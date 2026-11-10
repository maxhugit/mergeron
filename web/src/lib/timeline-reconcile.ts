/**
 * Reconciles a freshly fetched turn page against the timeline already on screen.
 *
 * Opening a thread used to replace the timeline outright whenever the returned
 * page was not wholly subsumed. Subscription and the open request run
 * concurrently, so on a refresh mid-turn the notifications that arrive while the
 * open is in flight were written into the timeline and then thrown away by the
 * response — re-creating the very gap the recovery pass exists to close.
 *
 * The rule is the same one the item merge follows: reconcile by identity, and
 * never let a coarser representation discard a finer one. Absence from a page
 * is not deletion.
 *
 * Reconciliation is done at TURN granularity, not row granularity. One turn
 * contributes several rows — the user message, the assistant turn, a failure —
 * and an earlier version of this file anchored on the turn id while matching on
 * `kind:turnId`. The two granularities disagreed exactly when a page carried a
 * row the live timeline lacked: the row counted as "already represented" for
 * anchoring and was then never emitted, so a refresh could drop the user's own
 * message; and a trailing group was re-emitted after every row sharing its
 * anchor turn, duplicating whole turns.
 */
import { mergeRecoveredItems } from '@/lib/turn-item-merge';
import type { TimelineEntry } from '@/types/timeline';
import { sameUserMessage, type UserEntry } from './timeline-user-messages';

/** Detail levels ordered so the richer view can be kept. */
const VIEW_RANK: Record<string, number> = { notLoaded: 0, summary: 1, full: 2 };

/** Identity used for anchoring; entries without one cannot be reconciled. */
function entryTurnId(entry: TimelineEntry): string | null {
  return entry.kind === 'system' || entry.kind === 'interaction'
    ? null
    : (entry.turnId ?? null);
}

/**
 * Chooses the surviving entry for a row present in both lists.
 *
 * The page comes from persistence, so it may fill gaps and settle turn
 * lifecycle, but the live entry keeps anything it observed first.
 */
function selectEntry(page: TimelineEntry, live: TimelineEntry): TimelineEntry {
  if (page.kind !== 'turn' || live.kind !== 'turn') {
    // A user message already on screen can carry locally attached images and
    // optimistic text the page does not reproduce.
    return live;
  }
  const pageRank = VIEW_RANK[page.itemsView ?? 'notLoaded'] ?? 0;
  const liveRank = VIEW_RANK[live.itemsView ?? 'notLoaded'] ?? 0;
  return {
    ...live,
    // The page is a snapshot fetched at an unknown moment, so it cannot outrank
    // a terminal observation already held; it still repairs fragments.
    items: mergeRecoveredItems(page.items, live.items, { baselineSeq: -1 }),
    // Turn lifecycle only moves forward. Either side reporting completion is
    // enough; neither side reverts the other to running.
    completed: page.completed || live.completed,
    plan: live.plan ?? page.plan,
    diff: live.diff ?? page.diff,
    itemsView: liveRank >= pageRank ? live.itemsView : page.itemsView,
  };
}

/**
 * Merges the rows of one turn, keeping every row either side contributed.
 *
 * Response/failure rows are matched by kind. User rows are matched individually
 * by native item identity, or by one unconfirmed occurrence, because steering
 * contributes several user messages to the same turn. A row only the page has
 * is inserted: live notifications can legitimately have been missed.
 *
 * @param pageRows - That turn's rows from the fetched page, in page order
 * @param liveRows - That turn's rows already rendered, in live order
 * @returns Repaired rows preserving the observed position of user steering
 */
function reconcileTurnRows(
  pageRows: TimelineEntry[],
  liveRows: TimelineEntry[],
  survivors: Map<TimelineEntry, TimelineEntry>,
): TimelineEntry[] {
  const pageByKind = new Map<string, TimelineEntry>();
  for (const row of pageRows)
    if (row.kind !== 'user') pageByKind.set(row.kind, row);
  const remainingUsers = pageRows.filter(
    (row): row is UserEntry => row.kind === 'user',
  );

  const liveKinds = new Set(liveRows.map((row) => row.kind));
  const merged = liveRows.map((row) => {
    if (row.kind === 'user') {
      let index = remainingUsers.findIndex(
        (candidate) => row.itemId && candidate.itemId === row.itemId,
      );
      if (index < 0)
        index = remainingUsers.findIndex(
          (candidate) =>
            (!row.itemId || !candidate.itemId) &&
            (sameUserMessage(row, candidate) ||
              (!row.steering && !candidate.steering)),
        );
      if (index < 0) return row;
      const [counterpart] = remainingUsers.splice(index, 1);
      return {
        ...row,
        ...(counterpart.itemId && { itemId: counterpart.itemId }),
        ...(counterpart.steering && { steering: true }),
      };
    }
    const counterpart = pageByKind.get(row.kind);
    return counterpart ? selectEntry(counterpart, row) : row;
  });

  liveRows.forEach((row, index) => survivors.set(row, merged[index]));

  // Keep the observed position of steering messages. Sorting every user row
  // ahead of the response rewrites the conversation on every history refresh.
  // Recovered users are inserted relative to the next known user in the page;
  // the original prompt alone has a guaranteed position before the response.
  const result = [...merged];
  const userIdentity = (a: UserEntry, b: UserEntry) =>
    a.itemId && b.itemId ? a.itemId === b.itemId : sameUserMessage(a, b);
  const pageUsers = pageRows.filter(
    (row): row is UserEntry => row.kind === 'user',
  );
  for (const user of remainingUsers) {
    const pageIndex = pageUsers.indexOf(user);
    const following = pageUsers.slice(pageIndex + 1);
    let index = result.findIndex(
      (row) =>
        row.kind === 'user' &&
        following.some((candidate) => userIdentity(row, candidate)),
    );
    if (!user.steering) {
      const responseIndex = result.findIndex((row) => row.kind === 'turn');
      if (responseIndex >= 0 && (index < 0 || responseIndex < index))
        index = responseIndex;
    }
    if (index < 0) {
      const failureIndex = result.findIndex(
        (row) => row.kind === 'turnFailure',
      );
      index = failureIndex >= 0 ? failureIndex : result.length;
    }
    result.splice(index, 0, user);
  }
  for (const row of pageRows) {
    if (row.kind === 'user' || liveKinds.has(row.kind)) continue;
    // A recovered response follows the initial prompt, while a failure follows
    // all response content. Never move a known steering row to repair it.
    const index =
      row.kind === 'turn'
        ? result.findIndex(
            (entry) =>
              entry.kind === 'turnFailure' ||
              (entry.kind === 'user' && entry.steering),
          )
        : -1;
    result.splice(index < 0 ? result.length : index, 0, row);
  }
  return result;
}

/**
 * Merges a chronological turn page into the chronological timeline held.
 *
 * Turns shared by both anchor the result. Turns only the page knows are placed
 * relative to the nearest shared anchor that preceded them, which is the only
 * ordering evidence available — the two views share no sequence.
 *
 * @param page - Entries built from the fetched page, oldest first
 * @param live - Entries currently rendered, oldest first
 * @returns One ordered timeline preserving both inputs' content
 */
export function reconcileTimeline(
  page: TimelineEntry[],
  live: TimelineEntry[],
): TimelineEntry[] {
  if (page.length === 0) return live;
  if (live.length === 0) return page;

  // Group for identity matching, but retain each live row's position. System
  // notices and approval interactions may sit between a response and steering;
  // collapsing the whole turn at its first row would move them out of order.
  const liveGroups = new Map<string, TimelineEntry[]>();
  const liveOrder: Array<{ turnId: string | null; entry: TimelineEntry }> = [];
  for (const entry of live) {
    const turnId = entryTurnId(entry);
    if (turnId === null) {
      liveOrder.push({ turnId: null, entry });
      continue;
    }
    const group = liveGroups.get(turnId);
    if (group) group.push(entry);
    else liveGroups.set(turnId, [entry]);
    liveOrder.push({ turnId, entry });
  }

  // Page rows grouped the same way, plus the anchor each unknown turn follows.
  const pageGroups = new Map<string, TimelineEntry[]>();
  const trailing = new Map<string | null, string[]>();
  const seenUnknown = new Set<string>();
  let anchor: string | null = null;
  for (const entry of page) {
    const turnId = entryTurnId(entry);
    if (turnId === null) continue;
    const group = pageGroups.get(turnId);
    if (group) group.push(entry);
    else pageGroups.set(turnId, [entry]);

    if (liveGroups.has(turnId)) {
      anchor = turnId;
    } else if (!seenUnknown.has(turnId)) {
      seenUnknown.add(turnId);
      const bucket = trailing.get(anchor);
      if (bucket) bucket.push(turnId);
      else trailing.set(anchor, [turnId]);
    }
  }

  /** Emits every row of a page-only turn. */
  const emitPageTurns = (
    turnIds: string[] | undefined,
    out: TimelineEntry[],
  ) => {
    for (const turnId of turnIds ?? [])
      out.push(...(pageGroups.get(turnId) ?? []));
  };

  const merged: TimelineEntry[] = [];
  const survivors = new Map<TimelineEntry, TimelineEntry>();
  const queues = new Map<string, TimelineEntry[]>();
  for (const [turnId, liveRows] of liveGroups) {
    const pageRows = pageGroups.get(turnId);
    queues.set(
      turnId,
      pageRows
        ? reconcileTurnRows(pageRows, liveRows, survivors)
        : [...liveRows],
    );
    if (!pageRows) liveRows.forEach((row) => survivors.set(row, row));
  }
  emitPageTurns(trailing.get(null), merged);
  for (const { turnId, entry } of liveOrder) {
    if (turnId === null) {
      merged.push(entry);
      continue;
    }
    const queue = queues.get(turnId)!;
    const survivor = survivors.get(entry);
    const index = queue.indexOf(survivor!);
    if (index >= 0) merged.push(...queue.splice(0, index + 1));
    const liveRows = liveGroups.get(turnId)!;
    if (entry === liveRows[liveRows.length - 1]) {
      merged.push(...queue);
      emitPageTurns(trailing.get(turnId), merged);
    }
  }
  return merged;
}

/**
 * Whether a page and the live timeline describe overlapping history.
 *
 * Without a shared turn the two are disconnected windows, and interleaving them
 * would preserve every entry while silently hiding the gap between them.
 */
export function sharesHistory(
  page: TimelineEntry[],
  live: TimelineEntry[],
): boolean {
  const liveTurnIds = new Set(
    live.map(entryTurnId).filter((id): id is string => id !== null),
  );
  return page.some((entry) => {
    const turnId = entryTurnId(entry);
    return turnId !== null && liveTurnIds.has(turnId);
  });
}
