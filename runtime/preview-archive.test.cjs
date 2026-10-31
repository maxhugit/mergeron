'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: yieldLoop } = require('node:timers/promises');
const archive = require('./preview-archive.cjs');

function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((value, byte) => value + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}
function member(name, data = Buffer.alloc(0), overrides = {}) {
  const header = Buffer.alloc(512);
  const put = (value, at, length) => header.write(value, at, length, 'ascii');
  const octal = (value, length) =>
    value.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(overrides.mode ?? 0o600, 8), 100, 8);
  put(octal(overrides.uid ?? 11002, 8), 108, 8);
  put(octal(overrides.gid ?? 11002, 8), 116, 8);
  put(octal(overrides.size ?? data.length, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put(overrides.type ?? '0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  return Buffer.concat([
    checksum(header),
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}
const tar = (...members) => Buffer.concat([...members, Buffer.alloc(1024)]);

test('cooperative parsing has exactly the synchronous validator results and yields during large inventories', async () => {
  const data = tar(
    ...Array.from({ length: 1000 }, (_, n) =>
      member(`file-${n}`, Buffer.from('test')),
    ),
  );
  let parsingDone = false;
  const parsing = archive.entriesAsync(data).then((value) => {
    parsingDone = true;
    return value;
  });
  await yieldLoop();
  assert.equal(
    parsingDone,
    false,
    'the complete inventory must not block one event-loop turn',
  );
  assert.deepEqual(await parsing, archive.entries(data));
  assert.equal(parsingDone, true);
});

test('both APIs reject unsafe USTAR without loosening names, identities, types or limits', async () => {
  const damaged = tar(member('file'));
  damaged[0] ^= 1;
  const unsafe = [
    damaged,
    Buffer.alloc(1024),
    tar(member('../outside')),
    tar(member('/etc/passwd')),
    tar(member('.mergeron-system/private')),
    tar(member('duplicate'), member('duplicate')),
    tar(member('file', undefined, { uid: 0 })),
    tar(member('file', undefined, { gid: 0 })),
    tar(member('file', undefined, { mode: 0o777 })),
    ...['1', '2', '3', '4', '6', 'x', 'g', 'S'].map((type) =>
      tar(member('file', undefined, { type })),
    ),
    tar(member('directory/', Buffer.from('x'), { type: '5' })),
    tar(member('file', undefined, { size: 16 * 1024 ** 2 + 1 })),
    tar(member('file', undefined, { size: 4096 })),
    member('file'),
    tar(member('file')).subarray(1),
    tar(...Array.from({ length: 15001 }, (_, n) => member(`file-${n}`))),
  ];
  for (const buffer of unsafe) {
    assert.throws(() => archive.entries(buffer), /PREVIEW_UNSAFE_ARCHIVE/);
    await assert.rejects(
      archive.entriesAsync(buffer),
      /PREVIEW_UNSAFE_ARCHIVE/,
    );
  }
});

test('cooperative parsing checks every byte of long zero padding without blocking', async () => {
  const data = Buffer.concat([member('file'), Buffer.alloc(4 * 1024 ** 2)]);
  let done = false;
  const parsing = archive.entriesAsync(data).then((value) => {
    done = true;
    return value;
  });
  await yieldLoop();
  assert.equal(done, false);
  assert.deepEqual(await parsing, archive.entries(data));
  data[data.length - 1] = 1;
  assert.throws(() => archive.entries(data), /PREVIEW_UNSAFE_ARCHIVE/);
  await assert.rejects(archive.entriesAsync(data), /PREVIEW_UNSAFE_ARCHIVE/);
});
