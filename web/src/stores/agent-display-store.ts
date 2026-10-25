import { create } from 'zustand';

export type AgentDisplayMode = 'hidden' | 'collapsed' | 'expanded';

export const useAgentDisplayStore = create<{
  byThread: Record<string, AgentDisplayMode>;
  record: (id: string, mode: AgentDisplayMode) => void;
}>((set) => ({
  byThread: {},
  record: (id, mode) =>
    set((state) => ({ byThread: { ...state.byThread, [id]: mode } })),
}));
