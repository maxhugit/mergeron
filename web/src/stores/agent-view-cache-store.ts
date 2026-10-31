/** Profile-backed project choice; retained agent views are memory-only. */
import { create } from 'zustand';

export const MAX_CACHED_AGENT_VIEWS = 5;
interface AgentViewCacheState {
  owner: string | null;
  projectId: string | null;
  /** Most recently visited last. No transcript or credential is persisted. */
  threadIds: string[];
  toggleProject: (projectId: string) => void;
  restorePreference: (owner: string | null, projectId: string | null) => void;
  visit: (projectId: string, threadId: string) => void;
  forget: (threadIds: readonly string[]) => void;
  clear: () => void;
}
export const useAgentViewCacheStore = create<AgentViewCacheState>((set) => ({
  owner: null,
  projectId: null,
  threadIds: [],
  restorePreference: (owner, projectId) =>
    set((state) =>
      state.owner === owner && state.projectId === projectId
        ? state
        : { owner, projectId, threadIds: [] },
    ),
  toggleProject: (projectId) =>
    set((state) => ({
      projectId: state.projectId === projectId ? null : projectId,
      threadIds: [],
    })),
  visit: (projectId, threadId) =>
    set((state) => {
      if (state.projectId !== projectId || state.threadIds.at(-1) === threadId)
        return state;
      return {
        threadIds: [
          ...state.threadIds.filter((id) => id !== threadId),
          threadId,
        ].slice(-MAX_CACHED_AGENT_VIEWS),
      };
    }),
  forget: (ids) =>
    set((state) => ({
      threadIds: state.threadIds.filter((id) => !ids.includes(id)),
    })),
  clear: () => set({ owner: null, projectId: null, threadIds: [] }),
}));
