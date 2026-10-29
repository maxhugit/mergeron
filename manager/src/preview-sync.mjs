/** Fixed, unprivileged helper. Linux proc-FD paths anchor all mutable traversal. */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import archive from '../../runtime/preview-archive.cjs';

const flags =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const root = fs.openSync('/target', flags),
  incoming = fs.openSync('/workspace', flags);
// tmpfs exists only while the helper is running. Upload source and control
// first, then a separate ready marker; never race a partially extracted file.
for (let n = 0; n < 1200 && !fs.existsSync('/control/ready'); n++)
  await new Promise((resolve) => setTimeout(resolve, 100));
if (!fs.existsSync('/control/ready')) throw Error('PREVIEW_SYNC_TIMEOUT');
const control = fs.openSync(
  '/control/spec.json',
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
);
try {
  if (fs.fstatSync(control).size > 8 * 1024 ** 2)
    throw Error('PREVIEW_UNSAFE_SYNC');
  const spec = JSON.parse(fs.readFileSync(control, 'utf8'));
  if (
    !Array.isArray(spec.entries) ||
    !Array.isArray(spec.removed) ||
    spec.entries.length > 15000 ||
    spec.removed.length > 15000
  )
    throw Error('PREVIEW_UNSAFE_SYNC');
  function parent(base, relative, create) {
    const parts = archive.safeName(relative).split('/');
    let fd = fs.openSync(
      `/proc/self/fd/${base}`,
      flags & ~fs.constants.O_NOFOLLOW,
    );
    try {
      for (const name of parts.slice(0, -1)) {
        const next = `/proc/self/fd/${fd}/${name}`;
        if (create) {
          try {
            fs.mkdirSync(next, { mode: 0o700 });
          } catch (e) {
            if (e.code !== 'EEXIST') throw e;
          }
        }
        const child = fs.openSync(next, flags);
        fs.closeSync(fd);
        fd = child;
      }
      return {
        fd,
        name: parts.at(-1),
        path: `/proc/self/fd/${fd}/${parts.at(-1)}`,
      };
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  }
  let changed = 0,
    removed = 0;
  for (const item of spec.entries) {
    if (item.type !== 'file' || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw Error('PREVIEW_UNSAFE_SYNC');
    const src = parent(incoming, item.name, false),
      dst = parent(root, item.name, true);
    let temp;
    try {
      const source = fs.openSync(
        src.path,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      let data;
      try {
        const st = fs.fstatSync(source);
        if (!st.isFile() || st.nlink !== 1 || st.size > 16 * 1024 ** 2)
          throw Error('PREVIEW_UNSAFE_SYNC');
        data = fs.readFileSync(source);
      } finally {
        fs.closeSync(source);
      }
      if (createHash('sha256').update(data).digest('hex') !== item.sha256)
        throw Error('PREVIEW_UNSAFE_SYNC');
      let same = false;
      try {
        const current = fs.openSync(
          dst.path,
          fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
        );
        try {
          const st = fs.fstatSync(current);
          if (!st.isFile() || st.nlink !== 1 || st.size > 16 * 1024 ** 2)
            throw Error('PREVIEW_UNSAFE_SYNC');
          same =
            st.size === data.length &&
            (st.mode & 0o777) === item.mode &&
            createHash('sha256')
              .update(fs.readFileSync(current))
              .digest('hex') === item.sha256;
        } finally {
          fs.closeSync(current);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (same) continue;
      temp = `/proc/self/fd/${dst.fd}/.mergeron-preview-${randomUUID()}`;
      const file = fs.openSync(
        temp,
        fs.constants.O_WRONLY |
          fs.constants.O_EXCL |
          fs.constants.O_CREAT |
          fs.constants.O_NOFOLLOW,
        item.mode,
      );
      try {
        fs.writeFileSync(file, data);
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      fs.renameSync(temp, dst.path);
      temp = null;
      changed++;
    } finally {
      if (temp) fs.unlinkSync(temp);
      fs.closeSync(src.fd);
      fs.closeSync(dst.fd);
    }
  }
  for (const name of spec.removed) {
    let dst;
    try {
      dst = parent(root, name, false);
      // unlink never follows a symlink and never recursively deletes directories.
      fs.unlinkSync(dst.path);
      removed++;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    } finally {
      if (dst) fs.closeSync(dst.fd);
    }
  }
  console.log(JSON.stringify({ changed, removed }));
} catch {
  console.error('PREVIEW_SYNC_FAILED');
  process.exitCode = 1;
} finally {
  fs.closeSync(control);
  fs.closeSync(root);
  fs.closeSync(incoming);
}
