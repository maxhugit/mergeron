export interface PreviewReceipt {
  schemaVersion: 1;
  generation: string;
  archiveSha: string;
  sourceFingerprint: string;
  copyId: string | null;
  gitCommit: string | null;
  syncedAt: number | null;
}
declare const contract: {
  receipt(value: unknown): PreviewReceipt;
  safeReceipt(value: unknown, archiveSha: unknown): PreviewReceipt | null;
};
export default contract;
