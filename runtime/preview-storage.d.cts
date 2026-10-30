export interface PreviewStorageLimits {
  backend: 'tmpfs';
  memoryCharged: true;
  workspaceMb: number;
  cacheMb: number;
  temporaryMb: number;
  dataMb: number;
  inodesPerVolume: number;
}
export interface PreviewStorageObservation {
  checkedAt: number;
  mounts: {
    role: string;
    path: string;
    totalBytes: number;
    availableBytes: number;
    totalInodes: number | null;
    availableInodes: number | null;
    cause: 'space_exhausted' | 'inodes_exhausted' | null;
  }[];
}
export interface PreviewStorageStatus {
  limits: PreviewStorageLimits;
  observation: PreviewStorageObservation | null;
}
declare const storage: {
  previewStorage: PreviewStorageLimits;
  safeStorageLimits(value: unknown): PreviewStorageLimits | null;
  safeStorageStatus(value: unknown): PreviewStorageStatus | null;
};
export default storage;
