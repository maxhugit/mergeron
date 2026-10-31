import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
  readlink,
  symlink,
  link,
  chmod,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import tar from '../vendor/tar-codec.cjs';
import {
  createBackupArchive,
  extractBackupArchive,
  BACKUP_ARCHIVE_FORMAT,
} from '../src/backup-archive.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'manager-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source'));
  return {
    root,
    source: join(root, 'source'),
    path: join(root, 'backup.tar.gz'),
    destination: join(root, 'restored'),
  };
}

test(
  'streams a standard compressed archive and restores Unicode/long names, permissions, timestamps and links',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.source, 'home'));
    const name = `home/${'é'.repeat(80)}.txt`;
    await writeFile(join(f.source, name), 'repeated content\n'.repeat(10000));
    await chmod(join(f.source, name), 0o640);
    const date = new Date('2026-01-02T03:04:05.123Z');
    await utimes(join(f.source, name), date, date);
    await link(join(f.source, name), join(f.source, 'home/hardlink'));
    await symlink('/not-followed', join(f.source, 'home/symlink'));
    await writeFile(join(f.source, 'home/plain.txt'), 'standard-reader');
    const descriptor = await createBackupArchive({
      root: f.source,
      path: f.path,
      roots: ['home'],
      policy: 'full-v1',
    });
    assert.equal(descriptor.format, BACKUP_ARCHIVE_FORMAT);
    assert.ok(descriptor.bytes < 10000);
    assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
    const standard = spawnSync('tar', ['-xzOf', f.path, 'home/plain.txt'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    assert.equal(standard.status, 0, standard.stderr);
    assert.equal(standard.stdout, 'standard-reader');
    const listing = spawnSync('tar', ['-tzf', f.path], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.ok(listing.stdout.normalize('NFC').includes(name));
    await extractBackupArchive({
      path: f.path,
      destination: f.destination,
      descriptor,
      roots: ['home'],
    });
    assert.equal(
      await readFile(join(f.destination, name), 'utf8'),
      'repeated content\n'.repeat(10000),
    );
    const restored = await lstat(join(f.destination, name));
    assert.equal(restored.mode & 0o777, 0o640);
    assert.equal(restored.uid, (await lstat(join(f.source, name))).uid);
    assert.equal(restored.mtimeMs, date.getTime());
    assert.equal(
      restored.ino,
      (await lstat(join(f.destination, 'home/hardlink'))).ino,
    );
    assert.equal(
      await readlink(join(f.destination, 'home/symlink')),
      '/not-followed',
    );
  },
);

test('minimal leaves preserve shared ancestors without including sibling secrets or directories', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'home/.codex'), { recursive: true });
  for (const name of ['a', 'b', 'not-selected'])
    await writeFile(join(f.source, 'home/.codex', name), name);
  const roots = ['home/.codex/a', 'home/.codex/b'];
  const descriptor = await createBackupArchive({
    root: f.source,
    path: f.path,
    roots,
    policy: 'minimal-v1',
  });
  await extractBackupArchive({
    path: f.path,
    destination: f.destination,
    descriptor,
    roots,
  });
  assert.equal(await readFile(join(f.destination, roots[0]), 'utf8'), 'a');
  await assert.rejects(lstat(join(f.destination, 'home/.codex/not-selected')), {
    code: 'ENOENT',
  });
});

test('incompressible data larger than a write checkpoint is streamed and restored intact', async (t) => {
  const f = await fixture(t);
  const value = randomBytes(10 * 1024 ** 2);
  await writeFile(join(f.source, 'binary'), value);
  const descriptor = await createBackupArchive({
    root: f.source,
    path: f.path,
    roots: ['binary'],
    policy: 'full-v1',
  });
  assert.ok(descriptor.bytes > 8 * 1024 ** 2);
  await extractBackupArchive({
    path: f.path,
    destination: f.destination,
    descriptor,
    roots: ['binary'],
  });
  assert.deepEqual(await readFile(join(f.destination, 'binary')), value);
});

test('archive integrity is required before any result is accepted', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'data'), 'original');
  const descriptor = await createBackupArchive({
    root: f.source,
    path: f.path,
    roots: ['data'],
    policy: 'full-v1',
  });
  await assert.rejects(
    extractBackupArchive({
      path: f.path,
      destination: f.destination,
      descriptor: { ...descriptor, sha256: '0'.repeat(64) },
      roots: ['data'],
    }),
    /updateBackupArchiveCorrupt/,
  );
});

async function malicious(f, entries) {
  const pack = tar.pack(),
    chunks = [];
  const collecting = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const entry of entries)
    await new Promise((resolve, reject) =>
      pack.entry(
        {
          mode: 0o600,
          uid: process.getuid(),
          gid: process.getgid(),
          mtime: new Date(),
          ...entry,
        },
        entry.type === 'file' ? Buffer.from('x') : undefined,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  pack.finalize();
  await collecting;
  const buffer = gzipSync(Buffer.concat(chunks));
  await writeFile(f.path, buffer);
  return {
    format: BACKUP_ARCHIVE_FORMAT,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    entries: entries.length,
    unpackedBytes: entries.filter((e) => e.type === 'file').length,
    restoreBytes: entries.filter((e) => e.type === 'file').length,
    tarBytes: Buffer.concat(chunks).length,
  };
}
for (const entries of [
  [{ name: '../escape', type: 'file', size: 1 }],
  [{ name: '/absolute', type: 'file', size: 1 }],
  [
    { name: 'home', type: 'symlink', linkname: '/tmp' },
    { name: 'home/escape', type: 'file', size: 1 },
  ],
  [
    { name: 'home', type: 'directory' },
    { name: 'home/a', type: 'file', size: 1 },
    { name: 'home/a', type: 'file', size: 1 },
  ],
  [
    { name: 'home', type: 'directory' },
    { name: 'home/device', type: 'fifo' },
  ],
])
  test(`rejects unsafe archive: ${entries.map((e) => e.name).join(',')}`, async (t) => {
    const f = await fixture(t);
    const descriptor = await malicious(f, entries);
    await assert.rejects(
      extractBackupArchive({
        path: f.path,
        destination: f.destination,
        descriptor,
        roots: ['home'],
      }),
    );
  });
