import tar from '../vendor/tar-codec.cjs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  open,
  lstat,
  opendir,
  mkdir,
  readlink,
  symlink,
  lchown,
  lutimes,
  link,
  statfs,
} from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable, Writable } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';
import { excludesBackupDirectory } from './backup-policy.mjs';

export const BACKUP_ARCHIVE_FORMAT = 'tar-gzip-v1';
export const BACKUP_ARCHIVE_NAME = 'backup.tar.gz';
const invalid = () => {
  throw Error('updateBackupArchiveInvalid');
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function safeName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    isAbsolute(name) ||
    name.includes('\\') ||
    name.includes('\0') ||
    Buffer.byteLength(name) > 4096 ||
    name.split('/').some((p) => !p || p === '.' || p === '..')
  )
    invalid();
  return name;
}
export function archiveDescriptor(operation) {
  const value = operation.backupArchive;
  if (value === undefined) return null; // Historical directory backups only.
  if (
    !value ||
    value.format !== BACKUP_ARCHIVE_FORMAT ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !integer(value.bytes) ||
    !integer(value.unpackedBytes) ||
    !integer(value.restoreBytes) ||
    value.restoreBytes < value.unpackedBytes ||
    !integer(value.tarBytes) ||
    value.tarBytes < value.unpackedBytes + 1024 ||
    value.tarBytes > value.unpackedBytes + value.entries * 16384 + 1024 ||
    !integer(value.entries) ||
    value.bytes < 20 ||
    value.entries < 1
  )
    invalid();
  return value;
}
function scope(roots) {
  if (
    !Array.isArray(roots) ||
    !roots.length ||
    roots.some((name) => safeName(name) !== name) ||
    new Set(roots).size !== roots.length ||
    roots.some((name, i) =>
      roots.some((other, j) => i !== j && name.startsWith(other + '/')),
    )
  )
    invalid();
  return (name, directory) =>
    roots.some(
      (root) =>
        name === root ||
        name.startsWith(root + '/') ||
        (directory && root.startsWith(name + '/')),
    );
}
async function parents(root, name) {
  const parts = name.split('/').slice(0, -1);
  for (let index = 1; index <= parts.length; index++) {
    const info = await lstat(join(root, ...parts.slice(0, index)));
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  }
}
function header(name, info, type, extra = {}) {
  return {
    name,
    type,
    mode: info.mode & 0o7777,
    uid: info.uid,
    gid: info.gid,
    mtime: info.mtime,
    pax: {
      'MERGERON.atime': String(info.atimeMs / 1000),
      mtime: String(info.mtimeMs / 1000),
      uid: String(info.uid),
      gid: String(info.gid),
      'MERGERON.nlink': String(info.nlink),
    },
    ...extra,
  };
}
function meter(hash, count, max = Infinity) {
  return new Transform({
    transform(chunk, _, done) {
      hash?.update(chunk);
      count.bytes += chunk.length;
      if (count.bytes > max) return done(Error('updateBackupArchiveInvalid'));
      done(null, chunk);
    },
  });
}

// FileHandle owns descriptor lifetime, including pipeline failures. fs stream
// destroy() may otherwise close a borrowed numeric descriptor behind our back.
function input(file) {
  return Readable.from(
    (async function* () {
      let position = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await file.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (!bytesRead) break;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })(),
    { objectMode: false, highWaterMark: 64 * 1024 },
  );
}
function output(file) {
  let unsynced = 0;
  return new Writable({
    write(chunk, _, done) {
      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(
            chunk,
            offset,
            chunk.length - offset,
            null,
          );
          if (!bytesWritten) throw Error('updateBackupArchiveWriteFailed');
          offset += bytesWritten;
        }
        // Bound dirty page-cache charges in the constrained Manager cgroup,
        // even when an incompressible archive is much larger than its RAM.
        unsynced += chunk.length;
        if (unsynced >= 8 * 1024 ** 2) {
          await file.datasync();
          unsynced = 0;
        }
      })().then(() => done(), done);
    },
  });
}

/** Sources are quiescent. Write one gzip stream, never a raw staging copy or a
 * userspace buffer proportional to backup size. Commit/durability is the caller's job.
 */
export async function createBackupArchive({ root, path, roots, policy }) {
  scope(roots);
  const sourceRoot = await lstat(root);
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) invalid();
  const destination = await open(path, 'wx+', 0o600);
  const pack = tar.pack();
  const hash = createHash('sha256');
  const count = { bytes: 0 };
  const tarCount = { bytes: 0 };
  let entries = 0,
    unpackedBytes = 0,
    restoreBytes = 0;
  const hardlinks = new Map();
  const implicit = new Set();
  const writing = pipeline(
    pack,
    meter(null, tarCount),
    createGzip({ level: 1 }),
    meter(hash, count),
    output(destination),
  );
  // Observe the pipeline immediately even while the source producer is awaiting I/O.
  writing.catch(() => {});
  async function empty(value) {
    await new Promise((resolve, reject) =>
      pack.entry(value, (error) => (error ? reject(error) : resolve())),
    );
    entries++;
  }
  async function visit(name) {
    safeName(name);
    const source = join(root, name);
    const info = await lstat(source);
    if (info.isDirectory() && excludesBackupDirectory(policy, name)) return;
    if (info.isSocket()) return;
    if (info.isDirectory()) {
      await empty(header(name, info, 'directory'));
      const directory = await opendir(source, { bufferSize: 8 });
      for await (const child of directory) await visit(`${name}/${child.name}`);
    } else if (info.isSymbolicLink()) {
      await empty(
        header(name, info, 'symlink', { linkname: await readlink(source) }),
      );
    } else if (info.isFile()) {
      restoreBytes += info.size;
      if (!integer(restoreBytes)) invalid();
      const identity = `${info.dev}:${info.ino}`;
      if (info.nlink > 1 && hardlinks.has(identity)) {
        await empty(
          header(name, info, 'link', { linkname: hardlinks.get(identity) }),
        );
        return;
      }
      const file = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.dev !== info.dev ||
          before.ino !== info.ino ||
          before.size !== info.size
        )
          invalid();
        await pipeline(
          input(file),
          pack.entry(header(name, info, 'file', { size: info.size })),
        );
        const after = await file.stat();
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw Error('updateBackupSourceChanged');
        entries++;
        unpackedBytes += info.size;
        if (!integer(unpackedBytes)) invalid();
        if (info.nlink > 1) hardlinks.set(identity, name);
      } finally {
        await file.close();
      }
    } else throw Error('updateUnsupportedPersistentFile');
  }
  try {
    // Minimal scopes contain separate leaves with shared ancestors. Sorted roots
    // keep the generated tar in directory-preorder, without duplicate headers.
    for (const name of [...roots].sort()) {
      await parents(root, name);
      const parts = name.split('/');
      for (let n = 1; n < parts.length; n++) {
        const parent = parts.slice(0, n).join('/');
        if (implicit.has(parent)) continue;
        implicit.add(parent);
        await empty(
          header(parent, await lstat(join(root, parent)), 'directory'),
        );
      }
      await visit(name);
    }
    pack.finalize();
    await writing;
    await destination.sync();
    const descriptor = {
      format: BACKUP_ARCHIVE_FORMAT,
      sha256: hash.digest('hex'),
      bytes: count.bytes,
      unpackedBytes,
      restoreBytes,
      tarBytes: tarCount.bytes,
      entries,
    };
    archiveDescriptor({ backupArchive: descriptor });
    // Re-read the durable compressed file before the transaction can replace
    // any container. This is bounded by archive size, never an extraction copy.
    const verified = createHash('sha256');
    for await (const chunk of input(destination)) verified.update(chunk);
    const stored = await destination.stat();
    if (
      stored.size !== descriptor.bytes ||
      verified.digest('hex') !== descriptor.sha256
    )
      throw Error('updateBackupArchiveCorrupt');
    return descriptor;
  } catch (error) {
    pack.destroy(error);
    await writing.catch(() => {});
    throw error;
  } finally {
    await destination.close();
  }
}

function timestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 8.64e12) invalid();
  // PAX contains fractional seconds. Date's integer milliseconds would discard
  // them. Linux/libuv utimes truncates to microseconds: aim at the middle of
  // that microsecond so floating-point error cannot drop another microsecond.
  const restored =
    process.platform === 'linux'
      ? (Math.round(seconds * 1e6) + Math.sign(seconds) * 0.5) / 1e6
      : seconds;
  // A numeric string also preserves pre-epoch timestamps; Node interprets a
  // negative number (unlike a Date or numeric string) as the current time.
  return String(restored);
}

function metadata(value) {
  const mode = value.mode;
  const uid = Number(value.pax?.uid ?? value.uid);
  const gid = Number(value.pax?.gid ?? value.gid);
  const originalMtime = value.pax?.mtime ?? value.mtime.getTime() / 1000;
  const mtime = timestamp(originalMtime);
  const atime = timestamp(value.pax?.['MERGERON.atime'] ?? originalMtime);
  if (
    !integer(mode) ||
    mode > 0o7777 ||
    !integer(uid) ||
    uid > 0xfffffffe ||
    !integer(gid) ||
    gid > 0xfffffffe
  )
    invalid();
  return { mode, uid, gid, mtime, atime };
}
async function applyMetadata(path, data, directory = false) {
  // Open before chown. No FOWNER or DAC_OVERRIDE is required afterwards.
  const file = await open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    await file.chmod(data.mode);
    await file.utimes(data.atime, data.mtime);
    await file.chown(data.uid, data.gid);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Extract only into a new private scratch directory, never live data. The full
 * stream, digest and limits must validate before the caller can swap any data.
 */
export async function extractBackupArchive({
  path,
  destination,
  descriptor,
  roots,
}) {
  archiveDescriptor({ backupArchive: descriptor });
  const allowed = scope(roots);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let reading;
  const extract = tar.extract();
  const hash = createHash('sha256'),
    count = { bytes: 0 };
  let entries = 0,
    unpackedBytes = 0;
  const directories = [];
  const hardlinks = new Map();
  const tarCount = { bytes: 0 };
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== descriptor.bytes)
      invalid();
    const space = await statfs(dirname(destination));
    if (
      space.bavail * space.bsize <
      descriptor.restoreBytes +
        descriptor.unpackedBytes +
        descriptor.entries * 4096 +
        64 * 1024 ** 2
    )
      throw Error('updateInsufficientBackupSpace');
    await mkdir(destination, { mode: 0o700 }); // exclusive destination, no reuse
    reading = pipeline(
      input(file),
      meter(hash, count, descriptor.bytes),
      createGunzip(),
      meter(null, tarCount, descriptor.tarBytes),
      extract,
    );
    reading.catch(() => {});
    for await (const entry of extract) {
      const h = entry.header;
      const name = safeName(h.name);
      if (
        ++entries > descriptor.entries ||
        !['file', 'directory', 'symlink', 'link'].includes(h.type) ||
        !allowed(name, h.type === 'directory') ||
        !integer(h.size) ||
        (h.type !== 'file' && h.size !== 0)
      )
        invalid();
      while (
        directories.length &&
        !name.startsWith(directories.at(-1).name + '/')
      ) {
        const directory = directories.pop();
        await applyMetadata(
          join(destination, directory.name),
          directory.data,
          true,
        );
      }
      await parents(destination, name);
      const target = join(destination, name),
        data = metadata(h);
      if (h.type === 'directory') {
        await mkdir(target, { mode: 0o700 });
        directories.push({ name, data });
      } else if (h.type === 'symlink') {
        if (
          typeof h.linkname !== 'string' ||
          h.linkname.includes('\0') ||
          Buffer.byteLength(h.linkname) > 4096
        )
          invalid();
        await symlink(h.linkname, target);
        await lutimes(target, data.atime, data.mtime);
        await lchown(target, data.uid, data.gid);
      } else if (h.type === 'link') {
        const previous = safeName(h.linkname);
        if (!allowed(previous, false) || !hardlinks.has(previous)) invalid();
        await parents(destination, previous);
        if (!(await lstat(join(destination, previous))).isFile()) invalid();
        await link(join(destination, previous), target);
      } else {
        unpackedBytes += h.size;
        if (!integer(unpackedBytes) || unpackedBytes > descriptor.unpackedBytes)
          invalid();
        const destinationFile = await open(target, 'wx', 0o600);
        try {
          await pipeline(entry, output(destinationFile));
        } finally {
          await destinationFile.close();
        }
        const nlink = Number(h.pax?.['MERGERON.nlink'] ?? 1);
        if (!integer(nlink) || nlink < 1) invalid();
        // Keep multi-linked files root-owned until all links exist. Linux
        // protected_hardlinks stays enabled; no CAP_FOWNER is needed.
        if (nlink > 1) hardlinks.set(name, data);
        else await applyMetadata(target, data);
      }
      if (h.type !== 'file') {
        for await (const ignored of entry) invalid();
      }
    }
    await reading;
    if (
      entries !== descriptor.entries ||
      unpackedBytes !== descriptor.unpackedBytes ||
      tarCount.bytes !== descriptor.tarBytes ||
      count.bytes !== descriptor.bytes ||
      hash.digest('hex') !== descriptor.sha256
    )
      throw Error('updateBackupArchiveCorrupt');
    for (const [name, data] of hardlinks)
      await applyMetadata(join(destination, name), data);
    while (directories.length) {
      const directory = directories.pop();
      await applyMetadata(
        join(destination, directory.name),
        directory.data,
        true,
      );
    }
    // All scope roots must exist; missing optional leaves were excluded by caller.
    for (const root of roots) await lstat(join(destination, root));
  } catch (error) {
    extract.destroy(error);
    if (reading) await reading.catch(() => {});
    if (['EEXIST', 'ELOOP', 'ENOTDIR'].includes(error.code)) invalid();
    if (
      error.code?.startsWith('Z_') ||
      (!error.code && !/^update[A-Z]/.test(error.message ?? ''))
    )
      throw Error('updateBackupArchiveCorrupt');
    throw error;
  } finally {
    await file.close();
  }
}
