import type { PreviewStorageBudget } from '../../../runtime/preview-storage.cjs';
/** Suggestions applied only to an administrator's unsaved policy form. */
export const previewResourcePresets: {
  id: 'static' | 'vite' | 'next';
  memoryMb: number;
  cpus: number;
  storageBudget: PreviewStorageBudget;
}[] = [
  {
    id: 'static',
    memoryMb: 256,
    cpus: 1,
    storageBudget: {
      workspaceMb: 512,
      cacheMb: 64,
      temporaryMb: 64,
      dataMb: 64,
    },
  },
  {
    id: 'vite',
    memoryMb: 2048,
    cpus: 1,
    storageBudget: {
      workspaceMb: 2048,
      cacheMb: 256,
      temporaryMb: 256,
      dataMb: 128,
    },
  },
  {
    id: 'next',
    memoryMb: 4096,
    cpus: 2,
    storageBudget: {
      workspaceMb: 4096,
      cacheMb: 512,
      temporaryMb: 512,
      dataMb: 256,
    },
  },
];
