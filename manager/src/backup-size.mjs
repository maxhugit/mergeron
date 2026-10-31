import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const backupIdentity = (value) =>
  `${value.dev}:${value.ino}:${value.mtimeMs}:${value.ctimeMs}`;

// Backups of terminal transactions are immutable. Only cache a complete result
// for that exact root, outside the backed-up data and the rollback journal.
export async function readBackupSize(path, expected) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) return null;
    const value = JSON.parse(await file.readFile('utf8'));
    if (
      value.schema !== 1 ||
      Object.entries(expected).some(([key, data]) => value[key] !== data) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0
    )
      return null;
    return value.bytes;
  } finally {
    await file.close();
  }
}

// Allocated disk space, like du: never follow links, count hardlinks once.
// Stream directory entries rather than retaining every path/inode in memory.
// This optional administrative statistic must leave CPU/I/O for /healthz.
export async function allocatedTreeSize(
  path,
  { check = () => {}, pause = () => delay(10) } = {},
) {
  const hardlinks = new Set();
  let bytes = 0;
  let visited = 0;
  async function visit(entry) {
    check();
    if (++visited % 64 === 0) {
      await pause();
      check();
    }
    const value = await lstat(entry);
    if (!value.isDirectory() && value.nlink > 1) {
      const inode = `${value.dev}:${value.ino}`;
      if (hardlinks.has(inode)) return;
      hardlinks.add(inode);
    }
    bytes += value.blocks * 512;
    if (value.isDirectory()) {
      const directory = await opendir(entry, { bufferSize: 8 });
      // The async iterator closes its handle on completion, failure or abort.
      for await (const child of directory) await visit(join(entry, child.name));
    }
  }
  await visit(path);
  return bytes;
}
