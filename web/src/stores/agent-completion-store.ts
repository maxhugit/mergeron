import { create } from 'zustand';

/** Live, session-only acknowledgements; never persist conversation identifiers. */
export const useAgentCompletionStore = create<{
  unread: ReadonlySet<string>;
  seen: ReadonlySet<string>;
  complete: (threadId: string, turnId: string) => void;
  acknowledge: (threadIds: readonly string[]) => void;
  clear: () => void;
}>((set) => ({
  unread: new Set(),
  seen: new Set(),
  complete: (threadId, turnId) =>
    set((state) => {
      const key = JSON.stringify([threadId, turnId]);
      if (state.seen.has(key)) return state;
      const seen = new Set(state.seen);
      seen.add(key);
      if (seen.size > 2048) seen.delete(seen.values().next().value!);
      return { seen, unread: new Set(state.unread).add(threadId) };
    }),
  acknowledge: (threadIds) =>
    set((state) => {
      if (!threadIds.some((id) => state.unread.has(id))) return state;
      const unread = new Set(state.unread);
      for (const id of threadIds) unread.delete(id);
      return { unread };
    }),
  clear: () => set({ unread: new Set(), seen: new Set() }),
}));
