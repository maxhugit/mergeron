/** Small, memory-only drafts survive view eviction; never persisted or sent automatically. */
import { create } from 'zustand';
import type { SetStateAction } from 'react';
import type { ChatAttachment } from '@/types/attachments';

const EMPTY_DRAFT = { text: '', attachments: [] as ChatAttachment[] };
type Draft = typeof EMPTY_DRAFT;
function updatedDrafts(
  drafts: Record<string, Draft>,
  id: string,
  draft: Draft,
) {
  const next = { ...drafts };
  if (draft.text || draft.attachments.length) next[id] = draft;
  else delete next[id];
  return next;
}
interface DraftState {
  drafts: Record<string, Draft>;
  forgotten: Set<string>;
  setText: (id: string, value: SetStateAction<string>) => void;
  setAttachments: (id: string, value: SetStateAction<ChatAttachment[]>) => void;
  forget: (ids: readonly string[]) => void;
}
export const useComposerDraftStore = create<DraftState>((set) => ({
  drafts: {},
  forgotten: new Set(),
  setText: (id, value) =>
    set((state) => {
      if (state.forgotten.has(id)) return state;
      const draft = state.drafts[id] ?? EMPTY_DRAFT;
      const text = typeof value === 'function' ? value(draft.text) : value;
      if (text === draft.text) return state;
      return { drafts: updatedDrafts(state.drafts, id, { ...draft, text }) };
    }),
  setAttachments: (id, value) =>
    set((state) => {
      if (state.forgotten.has(id)) return state;
      const draft = state.drafts[id] ?? EMPTY_DRAFT;
      const attachments =
        typeof value === 'function' ? value(draft.attachments) : value;
      if (attachments === draft.attachments) return state;
      return {
        drafts: updatedDrafts(state.drafts, id, { ...draft, attachments }),
      };
    }),
  forget: (ids) =>
    set((state) => {
      const drafts = { ...state.drafts };
      for (const id of ids) {
        for (const attachment of drafts[id]?.attachments ?? [])
          if (attachment.type === 'localImage' && attachment.previewUrl)
            URL.revokeObjectURL(attachment.previewUrl);
        delete drafts[id];
      }
      return { drafts, forgotten: new Set([...state.forgotten, ...ids]) };
    }),
}));

export const emptyDraftAttachments = EMPTY_DRAFT.attachments;
