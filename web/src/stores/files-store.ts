/**
 * Zustand store for file browser UI state only.
 * REST data (tree, content, metadata) is managed by TanStack Query.
 */
import { create } from 'zustand';
import { pathIsWithin, remapFilePath } from '@/lib/file-change-events';

interface FilesState {
  /** Current root directory (from thread cwd or home). */
  rootDir: string | null;
  /** Currently selected file path. */
  selectedFile: string | null;
  setRootDir: (dir: string | null) => void;
  selectFile: (filePath: string | null) => void;
  navigateUp: () => void;
  remapPaths: (oldPath: string, newPath: string) => void;
  removePaths: (deletedPath: string) => void;
}

const createFilesStore = () =>
  create<FilesState>((set, get) => ({
    rootDir: null,
    selectedFile: null,

    setRootDir: (dir: string | null) => {
      if (dir === get().rootDir) return;
      set({
        rootDir: dir,
        selectedFile: null,
      });
    },

    /** Selects the standalone browser's view; document and reveal ownership live outside the tree. */
    selectFile: (filePath) => set({ selectedFile: filePath }),

    // Containment and remapping come from the shared change vocabulary rather
    // than a second inline copy: the two diverge at a root parent, where the
    // hand-written form builds `//` and reports no match.
    remapPaths: (oldPath, newPath) =>
      set((state) => {
        const remap = (path: string | null) =>
          path ? (remapFilePath(path, oldPath, newPath) ?? path) : path;
        return {
          rootDir: remap(state.rootDir),
          selectedFile: remap(state.selectedFile),
        };
      }),

    removePaths: (deletedPath) =>
      set((state) => {
        const drop = (path: string | null) =>
          path && pathIsWithin(path, deletedPath) ? null : path;
        return {
          rootDir: drop(state.rootDir),
          selectedFile: drop(state.selectedFile),
        };
      }),

    navigateUp: () => {
      const { rootDir } = get();
      if (!rootDir || rootDir === '/') return;
      const parent = rootDir.substring(0, rootDir.lastIndexOf('/')) || '/';
      get().setRootDir(parent);
    },
  }));

/** Conversation explorers must not replace the global operations browser. */
export const useFilesStore = createFilesStore();
export const useGlobalFilesStore = createFilesStore();

const agentBrowsers = new Map<string, ReturnType<typeof createFilesStore>>();
export function getAgentFilesStore(threadId: string) {
  let store = agentBrowsers.get(threadId);
  if (!store) {
    store = createFilesStore();
    agentBrowsers.set(threadId, store);
  }
  return store;
}
export function retainAgentFilesStores(threadIds: readonly string[]) {
  for (const id of agentBrowsers.keys())
    if (!threadIds.includes(id)) agentBrowsers.delete(id);
}
export function allFilesStores() {
  return [useFilesStore, useGlobalFilesStore, ...agentBrowsers.values()];
}
