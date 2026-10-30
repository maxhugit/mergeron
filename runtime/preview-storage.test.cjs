const { test } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('./preview-storage.cjs');

test('distinguishes byte exhaustion, inode exhaustion and unknown inode counts', () => {
  const stat = { blocks: 100, bsize: 4096, bavail: 1, files: 50, ffree: 1 };
  assert.equal(storage.storageSample(stat).cause, null);
  assert.equal(
    storage.storageSample({ ...stat, bavail: 0 }).cause,
    'space_exhausted',
  );
  assert.equal(
    storage.storageSample({ ...stat, ffree: 0 }).cause,
    'inodes_exhausted',
  );
  assert.equal(
    storage.storageSample({ ...stat, files: 0, ffree: 0 }).cause,
    null,
  );
  assert.equal(
    storage.storageSample({ ...stat, files: 0, ffree: 0 }).availableInodes,
    null,
  );
});
test('only allowlisted numeric diagnostics cross the Manager boundary', () => {
  const value = {
    version: 1,
    checkedAt: 123,
    mounts: storage.storageMounts.map((m) => ({
      role: m.role,
      totalBytes: 4096,
      availableBytes: 4096,
      totalInodes: 0,
      availableInodes: 0,
      path: '/secret',
      cause: 'fabricated',
      token: 'private',
    })),
  };
  const observed = storage.readStorageObservation(JSON.stringify(value));
  assert.equal(observed.mounts[0].path, '/workspace');
  assert.equal(observed.mounts[0].cause, null);
  assert.equal(observed.mounts[0].availableInodes, null);
  assert.equal(JSON.stringify(observed).includes('private'), false);
  assert.equal(
    storage.readStorageObservation('untrusted application text'),
    null,
  );
  value.mounts[0].availableBytes = -1;
  assert.equal(storage.readStorageObservation(JSON.stringify(value)), null);
  value.mounts[0].availableBytes = 4097;
  assert.equal(storage.readStorageObservation(JSON.stringify(value)), null);
  assert.equal(storage.safeStorageStatus({ limits: {} }), null);
});
test('cache paths never use sources, data or the bounded temporary volume', () => {
  for (const [name, value] of Object.entries(storage.cacheEnvironment)) {
    if (name === 'TMPDIR') assert.equal(value, '/tmp');
    else assert.match(value, /^\/cache\//);
  }
});
