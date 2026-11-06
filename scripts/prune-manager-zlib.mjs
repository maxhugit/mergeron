/** Remove only the unused Debian shared zlib package from the pinned distroless runtime. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  readlinkSync,
  lstatSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

export function pruneManagerZlib(
  root = '/',
  sharedObjects = process.report.getReport().sharedObjects,
) {
  assert(
    !sharedObjects.some((file) =>
      /(?:^|\/)libz(?:\.so|\.[^/]*dylib)/.test(file),
    ),
    'Node depends on shared zlib; refusing removal',
  );
  const base = realpathSync(root);
  const inside = (relative) => path.join(base, relative);
  const status = 'var/lib/dpkg/status.d/zlib1g';
  const sums = status + '.md5sums';
  for (const file of [status, sums])
    assert(lstatSync(inside(file)).isFile(), 'Unexpected package metadata');
  const metadata = readFileSync(inside(status), 'utf8');
  assert.match(metadata, /^Package: zlib1g$/m);
  assert.match(metadata, /^Architecture: amd64$/m);
  const library = 'usr/lib/x86_64-linux-gnu/libz.so.1.3.1';
  const link = 'usr/lib/x86_64-linux-gnu/libz.so.1';
  const allowed = new Set([
    library,
    'usr/share/doc/zlib1g/changelog.Debian.amd64.gz',
    'usr/share/doc/zlib1g/changelog.Debian.gz',
    'usr/share/doc/zlib1g/changelog.gz',
    'usr/share/doc/zlib1g/copyright',
  ]);
  const files = readFileSync(inside(sums), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^[0-9a-f]{32}\s+(.+)$/.exec(line);
      assert(
        match && allowed.has(match[1]),
        'Unexpected zlib package file; review the pinned base before removing',
      );
      return match[1];
    });
  assert(
    files.includes(library),
    'Shared library missing from package inventory',
  );
  assert(lstatSync(inside(library)).isFile(), 'Unexpected shared library');
  assert(lstatSync(inside(link)).isSymbolicLink());
  assert.equal(readlinkSync(inside(link)), path.basename(library));
  // Validate all parents before any deletion; do not follow filesystem aliases.
  for (const file of [...files, link, status, sums]) {
    const parent = path.dirname(inside(file));
    assert.equal(
      realpathSync(parent),
      parent,
      'Unexpected package directory alias',
    );
  }
  for (const file of [...files, link, status, sums])
    rmSync(inside(file), { force: true });
  return {
    removedPackage: 'zlib1g',
    removedVersion: /^Version: (.+)$/m.exec(metadata)?.[1],
    sharedZlibLoaded: false,
  };
}
