'use strict';
/** Public diagnostic metadata, never an authorization capability or build proof. */
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
function receipt(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !uuid.test(value.generation) ||
    !sha.test(value.archiveSha) ||
    !sha.test(value.sourceFingerprint) ||
    !(
      value.gitCommit === null ||
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.gitCommit)
    ) ||
    !(
      value.copyId === null ||
      (typeof value.copyId === 'string' &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(value.copyId))
    ) ||
    !(
      value.syncedAt === null ||
      (Number.isSafeInteger(value.syncedAt) && value.syncedAt > 0)
    )
  )
    throw Error('PREVIEW_INVALID_RECEIPT');
  return {
    schemaVersion: 1,
    generation: value.generation,
    archiveSha: value.archiveSha,
    sourceFingerprint: value.sourceFingerprint,
    copyId: value.copyId,
    gitCommit: value.gitCommit,
    syncedAt: value.syncedAt,
  };
}
function safeReceipt(value, archiveSha) {
  try {
    const result = receipt(value);
    return result.archiveSha === archiveSha && result.syncedAt !== null
      ? result
      : null;
  } catch {
    return null;
  }
}
module.exports = { receipt, safeReceipt };
