/** Conversation timeline navigation actions. */
import { useWorkspaceStore } from './workspace-store';
import { useComposerDraftStore } from './composer-draft-store';
import { forgetTranscriptBookmarks } from '@/lib/transcript-anchor';
import { getSocket } from '../socket';
import { forgetThreadPolicy } from './thread-policy-store';
import { invalidateThreadEpoch } from '../lib/thread-recovery-epoch';
import { excludePendingReads } from '../lib/pending-read-coverage';
import { currentThreadEpoch } from '../lib/thread-recovery-epoch';
import {
  MAX_CACHED_AGENT_VIEWS,
  useAgentViewCacheStore,
} from './agent-view-cache-store';
import {
  type TimelineState,
  type TimelineActionContext,
} from './timeline-state';
import {
  normalizeMaxIdleSubscriptions,
  createRuntime,
  readRuntime,
  selectedFields,
  persistSelectedRuntime,
  hasPendingApproval,
  touchRuntime,
  isSafeToCleanupIdleRuntime,
  compareIdleCleanupCandidates,
} from './timeline-runtime';

/** Concrete navigation mutations keep each conversation's ownership and lifecycle explicit. */
export function createTimelineNavigationActions({
  set,
  get,
  applyThreadUpdate,
}: TimelineActionContext): Pick<
  TimelineState,
  | 'ensureThreadState'
  | 'selectThread'
  | 'resubscribeAll'
  | 'setRetainedThreads'
  | 'clearConfirmedThreads'
  | 'unsubscribeThread'
  | 'forgetThreads'
  | 'setMaxIdleSubscriptions'
  | 'cleanupIdleThreadSubscriptions'
  | 'getThreadTitle'
  | 'getThreadRuntime'
  | 'isThreadBusy'
  | 'hasPendingApproval'
  | 'setActiveThread'
  | 'setReadOnlyThread'
  | 'setThreadCwdForThread'
  | 'clearThread'
> {
  let leaseSequence = 0;
  const roomLeases = new Map<string, number>();
  return {
    ensureThreadState: (input) => {
      set((state) => {
        const existing = readRuntime(state, input.threadId);
        if (existing) return {};
        return {
          threadsById: {
            ...persistSelectedRuntime(state),
            [input.threadId]: createRuntime(input),
          },
        };
      });
    },

    selectThread: (threadId) => {
      for (const subscribed of get().subscribedThreadIds) {
        if (subscribed !== threadId && !get().retainedThreadIds.has(subscribed))
          get().unsubscribeThread(subscribed);
      }
      set((state) => {
        const threadsById = persistSelectedRuntime(state);
        if (!threadId) {
          return {
            ...selectedFields(null),
            selectedThreadId: null,
            threadsById,
          };
        }
        const runtime = touchRuntime(
          threadsById[threadId] ?? createRuntime({ threadId }),
        );
        return {
          ...selectedFields(runtime),
          selectedThreadId: threadId,
          threadsById: { ...threadsById, [threadId]: runtime },
        };
      });
    },

    resubscribeAll: (onSubscribed) => {
      const socket = getSocket();
      const connection = socket.id;
      for (const threadId of get().subscribedThreadIds) {
        const epoch = currentThreadEpoch(threadId);
        const lease = ++leaseSequence;
        roomLeases.set(threadId, lease);
        socket.emit(
          'thread.subscribe',
          { threadId },
          (reply: { ok?: boolean }) => {
            if (
              reply?.ok &&
              socket.connected &&
              socket.id === connection &&
              get().subscribedThreadIds.has(threadId) &&
              roomLeases.get(threadId) === lease &&
              epoch === currentThreadEpoch(threadId)
            ) {
              set((state) => ({
                confirmedThreadIds: new Set(state.confirmedThreadIds).add(
                  threadId,
                ),
              }));
              onSubscribed?.(threadId);
            }
          },
        );
      }
    },

    setRetainedThreads: (ids) => {
      const retainedThreadIds = new Set(ids.slice(-MAX_CACHED_AGENT_VIEWS));
      if (
        retainedThreadIds.size !== get().retainedThreadIds.size ||
        [...retainedThreadIds].some((id) => !get().retainedThreadIds.has(id))
      )
        set({ retainedThreadIds });
      for (const subscribed of get().subscribedThreadIds)
        if (subscribed !== get().threadId && !retainedThreadIds.has(subscribed))
          get().unsubscribeThread(subscribed);
    },

    clearConfirmedThreads: () => {
      roomLeases.clear();
      set({ confirmedThreadIds: new Set<string>() });
    },

    unsubscribeThread: (threadId) => {
      roomLeases.delete(threadId);
      const socket = getSocket();
      if (socket.connected) socket.emit('thread.unsubscribe', { threadId });
      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        subscribedThreadIds.delete(threadId);
        const confirmedThreadIds = new Set(state.confirmedThreadIds);
        confirmedThreadIds.delete(threadId);
        return { subscribedThreadIds, confirmedThreadIds };
      });
    },

    /**
     * Drops every trace of threads that no longer exist.
     *
     * `unsubscribeThread` only leaves the socket room; the runtime survives in
     * `threadsById` and would be handed straight back to a deep link or a back
     * navigation to a deleted thread, showing content for a conversation that
     * is gone. The selected runtime needs special care: it lives in the
     * top-level fields, and the usual `selectThread(null)` path persists it into
     * `threadsById` on the way out — which would resurrect what we are deleting.
     *
     * @param threadIds - Threads that were destroyed
     */
    forgetThreads: (threadIds) => {
      useComposerDraftStore.getState().forget(threadIds);
      useAgentViewCacheStore.getState().forget(threadIds);
      useWorkspaceStore.getState().forgetConversations(threadIds);
      forgetTranscriptBookmarks(threadIds);
      const doomed = new Set(threadIds);
      if (doomed.size === 0) return;
      excludePendingReads(doomed);

      const socket = getSocket();
      const subscribed = get().subscribedThreadIds;
      for (const threadId of doomed) {
        roomLeases.delete(threadId);
        invalidateThreadEpoch(threadId);
        if (subscribed.has(threadId)) {
          if (socket.connected) socket.emit('thread.unsubscribe', { threadId });
        }
      }

      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        const retainedThreadIds = new Set(state.retainedThreadIds);
        const confirmedThreadIds = new Set(state.confirmedThreadIds);
        for (const threadId of doomed) {
          subscribedThreadIds.delete(threadId);
          retainedThreadIds.delete(threadId);
          confirmedThreadIds.delete(threadId);
        }

        const selectedDoomed =
          state.selectedThreadId !== null && doomed.has(state.selectedThreadId);
        const threadsById = selectedDoomed
          ? { ...state.threadsById }
          : persistSelectedRuntime(state);
        for (const threadId of doomed) delete threadsById[threadId];

        return selectedDoomed
          ? {
              ...selectedFields(null),
              selectedThreadId: null,
              threadsById,
              subscribedThreadIds,
              retainedThreadIds,
              confirmedThreadIds,
            }
          : {
              threadsById,
              subscribedThreadIds,
              retainedThreadIds,
              confirmedThreadIds,
            };
      });
    },

    setMaxIdleSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(limit);
      set({ maxIdleSubscriptions });
      get().cleanupIdleThreadSubscriptions(maxIdleSubscriptions);
    },

    cleanupIdleThreadSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(
        limit ?? get().maxIdleSubscriptions,
      );
      const evictedThreadIds: string[] = [];
      const subscribedBefore = get().subscribedThreadIds;

      set((state) => {
        const candidates: Array<{ threadId: string; lastActivityAt: number }> =
          [];
        // Every held runtime, not only the subscribed ones. Attention delivery
        // creates state for conversations this browser never subscribed to and
        // may never open, so scanning subscriptions alone would leave exactly
        // those to accumulate for the life of the session. The safety predicate
        // still refuses to evict anything running or awaiting a decision.
        for (const threadId of Object.keys(persistSelectedRuntime(state))) {
          const runtime = readRuntime(state, threadId);
          if (
            !state.retainedThreadIds.has(threadId) &&
            isSafeToCleanupIdleRuntime(runtime, state.threadId)
          ) {
            candidates.push({
              threadId,
              lastActivityAt: runtime.lastActivityAt,
            });
          }
        }

        if (candidates.length <= maxIdleSubscriptions) return {};

        const now = Date.now();
        candidates.sort((a, b) => compareIdleCleanupCandidates(now, a, b));
        const evictCount = candidates.length - maxIdleSubscriptions;
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        const confirmedThreadIds = new Set(state.confirmedThreadIds);
        const threadsById = { ...persistSelectedRuntime(state) };

        for (const candidate of candidates.slice(0, evictCount)) {
          subscribedThreadIds.delete(candidate.threadId);
          confirmedThreadIds.delete(candidate.threadId);
          delete threadsById[candidate.threadId];
          evictedThreadIds.push(candidate.threadId);
        }

        return { subscribedThreadIds, confirmedThreadIds, threadsById };
      });

      const socket = getSocket();
      excludePendingReads(evictedThreadIds);
      for (const threadId of evictedThreadIds) {
        roomLeases.delete(threadId);
        invalidateThreadEpoch(threadId);
        forgetThreadPolicy(threadId);
        if (socket.connected && subscribedBefore.has(threadId))
          socket.emit('thread.unsubscribe', { threadId });
      }
    },

    getThreadTitle: (threadId) => {
      const runtime = readRuntime(get(), threadId);
      return runtime?.threadTitle ?? threadId.slice(0, 8);
    },

    getThreadRuntime: (threadId) => readRuntime(get(), threadId),

    isThreadBusy: (threadId) =>
      Boolean(
        readRuntime(get(), threadId)?.turnStartPending ||
        readRuntime(get(), threadId)?.activeTurnId,
      ),

    hasPendingApproval: (threadId) =>
      hasPendingApproval(readRuntime(get(), threadId)),

    setActiveThread: (threadId, cwd, title) => {
      get().ensureThreadState({ threadId, cwd, title, mode: 'live' });
      get().selectThread(threadId);
      set((state) => ({
        subscribedThreadIds: new Set(state.subscribedThreadIds).add(threadId),
      }));
      get().cleanupIdleThreadSubscriptions();
      const socket = getSocket();
      if (socket.connected && get().confirmedThreadIds.has(threadId))
        return Promise.resolve(true);
      const connection = socket.id;
      const epoch = currentThreadEpoch(threadId);
      const lease = ++leaseSequence;
      roomLeases.set(threadId, lease);
      // Do not buffer room changes while disconnected. Reconnect joins the
      // final desired room; the opener can independently paint its HTTP page.
      if (!socket.connected) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        socket
          .timeout(10_000)
          .emit(
            'thread.subscribe',
            { threadId },
            (error: Error | null, reply?: { ok?: boolean }) => {
              const joined =
                !error &&
                Boolean(reply?.ok) &&
                socket.connected &&
                socket.id === connection &&
                get().subscribedThreadIds.has(threadId) &&
                roomLeases.get(threadId) === lease &&
                epoch === currentThreadEpoch(threadId);
              if (joined)
                set((state) => ({
                  confirmedThreadIds: new Set(state.confirmedThreadIds).add(
                    threadId,
                  ),
                }));
              resolve(joined);
            },
          );
      });
    },

    setReadOnlyThread: (thread) => {
      const title = thread.name ?? thread.preview ?? null;
      get().unsubscribeThread(thread.id);
      get().ensureThreadState({
        threadId: thread.id,
        cwd: thread.cwd,
        title,
        mode: 'readOnly',
      });
      // The failed writable open creates a live runtime before this degraded
      // path runs. `ensureThreadState` intentionally preserves existing state,
      // so the mode must be changed explicitly before selecting the snapshot.
      //
      // The timeline is deliberately untouched here. History now arrives as a
      // page through `hydrateOpenedThread`, which refuses to shrink a transcript
      // the user has already paged backwards through; seeding an empty timeline
      // first would discard those earlier pages and defeat that guard.
      applyThreadUpdate(thread.id, (runtime) => ({
        ...runtime,
        threadMode: 'readOnly',
      }));
      get().selectThread(thread.id);
    },

    setThreadCwdForThread: (threadId, cwd) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadCwd: cwd,
      }));
    },

    clearThread: () => get().selectThread(null),
  };
}
