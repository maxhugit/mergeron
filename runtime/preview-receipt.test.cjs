const { test } = require('node:test');
const assert = require('node:assert/strict');
const { receipt, safeReceipt } = require('./preview-receipt.cjs');
const valid = {
  schemaVersion: 1,
  generation: '11111111-1111-4111-8111-111111111111',
  archiveSha: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
  gitCommit: 'c'.repeat(40),
  copyId: 'copy',
  syncedAt: 123,
};
test('only a committed receipt for the exact archive is evidence', () => {
  assert.deepEqual(safeReceipt(valid, valid.archiveSha), valid);
  assert.equal(safeReceipt(valid, 'd'.repeat(64)), null);
  assert.equal(
    safeReceipt({ ...valid, syncedAt: null }, valid.archiveSha),
    null,
  );
  assert.equal(safeReceipt(null, valid.archiveSha), null);
  assert.deepEqual(receipt({ ...valid, secret: 'not public' }), valid);
});
test('malformed provenance cannot enter a public receipt', () => {
  for (const patch of [
    { generation: '<script>' },
    { gitCommit: 'HEAD' },
    { copyId: '../other' },
    { sourceFingerprint: 'x' },
    { syncedAt: -1 },
    { archiveSha: null },
    { schemaVersion: 2 },
  ])
    assert.throws(() => receipt({ ...valid, ...patch }));
});
