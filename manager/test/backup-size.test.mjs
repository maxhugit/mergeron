import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  lstat,
  link,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocatedTreeSize, readBackupSize } from '../src/backup-size.mjs';

test('streamed size matches allocated blocks, counts hardlinks once and does not traverse links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'manager-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = join(root, 'backup');
  const child = join(backup, 'child');
  await mkdir(child, { recursive: true });
  const file = join(child, 'file');
  await writeFile(file, 'content');
  await link(file, join(backup, 'hardlink'));
  await writeFile(join(root, 'outside'), Buffer.alloc(100000));
  const outside = join(backup, 'outside');
  await symlink(root, outside);
  const expected = (
    await Promise.all([backup, child, file, outside].map(lstat))
  ).reduce((sum, stat) => sum + stat.blocks * 512, 0);
  assert.equal(await allocatedTreeSize(backup), expected);
});

test('large directories yield in bounded batches and an interrupted scan never returns a partial size', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'manager-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let n = 0; n < 130; n++) await writeFile(join(root, String(n)), '');
  let pauses = 0;
  await allocatedTreeSize(root, {
    pause: async () => {
      pauses++;
    },
  });
  assert.equal(pauses, 2);
  let cancelled = false;
  await assert.rejects(
    allocatedTreeSize(root, {
      pause: async () => {
        cancelled = true;
      },
      check: () => {
        if (cancelled) throw new Error('cancelled');
      },
    }),
    /cancelled/,
  );
  // Every directory handle must also be closed after cancellation.
  assert.ok(Number.isSafeInteger(await allocatedTreeSize(root)));
});

test('size cache accepts only small regular files with exact scope/root and valid byte counts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'manager-size-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'cache.json');
  const expected = {
    stack: 'dev',
    environment: 'development',
    id: 'backup-id',
    identity: 'root-stat',
  };
  const valid = { schema: 1, ...expected, bytes: 1024 };
  await writeFile(path, JSON.stringify(valid));
  assert.equal(await readBackupSize(path, expected), 1024);
  for (const change of [
    { schema: 2 },
    { stack: 'prod' },
    { environment: 'production' },
    { id: 'other' },
    { identity: 'old-root' },
    { bytes: -1 },
    { bytes: 1.2 },
    { bytes: '100' },
    { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { padding: 'x'.repeat(4096) },
  ]) {
    await writeFile(path, JSON.stringify({ ...valid, ...change }));
    assert.equal(await readBackupSize(path, expected), null);
  }
  await rm(path);
  await symlink(join(root, 'outside.json'), path);
  await writeFile(join(root, 'outside.json'), JSON.stringify(valid));
  await assert.rejects(readBackupSize(path, expected));
  await rm(path);
  await mkdir(path);
  assert.equal(await readBackupSize(path, expected), null);
});
