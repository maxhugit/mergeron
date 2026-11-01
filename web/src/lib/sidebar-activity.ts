import type { TimelineState } from '@/stores/timeline-state';

export interface SidebarActivity {
  busy: boolean;
  active: boolean;
  waitingOnApproval: boolean;
  waitingOnUserInput: boolean;
  pendingApprovalCount: number;
}

/** One selector per sidebar: streamed text and token usage cannot repaint navigation. */
export function createSidebarActivitySelector() {
  let previous = new Map<string, SidebarActivity>();
  const approvalCounts = new WeakMap<TimelineState['approvals'], number>();
  return (state: TimelineState): ReadonlyMap<string, SidebarActivity> => {
    const ids = new Set(Object.keys(state.threadsById));
    if (state.threadId) ids.add(state.threadId);
    let next: Map<string, SidebarActivity> | undefined;
    for (const id of ids) {
      // The flat selected fields remain authoritative, just like the transcript.
      const runtime = id === state.threadId ? state : state.threadsById[id];
      let pendingApprovalCount = approvalCounts.get(runtime.approvals);
      if (pendingApprovalCount === undefined) {
        pendingApprovalCount = Object.values(runtime.approvals).filter(
          (approval) => approval.status === 'pending',
        ).length;
        approvalCounts.set(runtime.approvals, pendingApprovalCount);
      }
      const flags =
        runtime.threadStatus?.type === 'active'
          ? runtime.threadStatus.activeFlags
          : [];
      const value: SidebarActivity = {
        busy: Boolean(runtime.turnStartPending || runtime.activeTurnId),
        active: runtime.threadStatus?.type === 'active',
        waitingOnApproval: flags.includes('waitingOnApproval'),
        waitingOnUserInput: flags.includes('waitingOnUserInput'),
        pendingApprovalCount,
      };
      const held = previous.get(id);
      if (
        !held ||
        held.busy !== value.busy ||
        held.active !== value.active ||
        held.waitingOnApproval !== value.waitingOnApproval ||
        held.waitingOnUserInput !== value.waitingOnUserInput ||
        held.pendingApprovalCount !== value.pendingApprovalCount
      ) {
        next ??= new Map(previous);
        next.set(id, value);
      }
    }
    for (const id of previous.keys()) {
      if (!ids.has(id)) {
        next ??= new Map(previous);
        next.delete(id);
      }
    }
    if (next) previous = next;
    return previous;
  };
}
