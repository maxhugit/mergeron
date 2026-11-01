/** Profile-backed project choice. Only a bounded list of IDs survives reload. */
import { create } from 'zustand';

export const MAX_CACHED_AGENT_VIEWS = 5;
const storageKey = (owner: string, projectId: string) =>
  `mergeron:agent-navigation:v1:${encodeURIComponent(owner)}:${encodeURIComponent(projectId)}`;
function remembered(owner: string | null, projectId: string | null): string[] {
  if (!owner || !projectId) return [];
  try {
    const ids: unknown = JSON.parse(
      sessionStorage.getItem(storageKey(owner, projectId)) ?? '[]',
    );
    return Array.isArray(ids)
      ? [
          ...new Set(
            ids.filter(
              (id): id is string =>
                typeof id === 'string' && id.length > 0 && id.length < 200,
            ),
          ),
        ].slice(-MAX_CACHED_AGENT_VIEWS)
      : [];
  } catch {
    return [];
  }
}
function remember(
  state: {
    owner: string | null;
    projectId: string | null;
    threadIds: string[];
  },
  remove = false,
) {
  if (!state.owner || !state.projectId) return;
  try {
    const key = storageKey(state.owner, state.projectId);
    if (remove) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(state.threadIds));
  } catch {
    /* Storage may be disabled; retention still works in memory. */
  }
}
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
    set((state) => {
      if (state.owner === owner && state.projectId === projectId) return state;
      remember(state, true);
      return { owner, projectId, threadIds: remembered(owner, projectId) };
    }),
  toggleProject: (projectId) =>
    set((state) => {
      remember(state, true);
      return {
        projectId: state.projectId === projectId ? null : projectId,
        threadIds: [],
      };
    }),
  visit: (projectId, threadId) =>
    set((state) => {
      if (state.projectId !== projectId || state.threadIds.at(-1) === threadId)
        return state;
      const next = {
        threadIds: [
          ...state.threadIds.filter((id) => id !== threadId),
          threadId,
        ].slice(-MAX_CACHED_AGENT_VIEWS),
      };
      remember({ ...state, ...next });
      return next;
    }),
  forget: (ids) =>
    set((state) => {
      if (!state.threadIds.some((id) => ids.includes(id))) return state;
      const threadIds = state.threadIds.filter((id) => !ids.includes(id));
      remember({ ...state, threadIds });
      return { threadIds };
    }),
  clear: () =>
    set((state) => {
      remember(state, true);
      return { owner: null, projectId: null, threadIds: [] };
    }),
}));
