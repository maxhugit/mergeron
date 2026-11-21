/** Remove the unused Debian OpenSSL shared libraries from the pinned Manager image. */
import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

export const opensslFiles = [
  'usr/lib/x86_64-linux-gnu/engines-3/afalg.so',
  'usr/lib/x86_64-linux-gnu/engines-3/loader_attic.so',
  'usr/lib/x86_64-linux-gnu/engines-3/padlock.so',
  'usr/lib/x86_64-linux-gnu/libcrypto.so.3',
  'usr/lib/x86_64-linux-gnu/libssl.so.3',
  'usr/share/doc/libssl3t64/NEWS.Debian.gz',
  'usr/share/doc/libssl3t64/changelog.Debian.gz',
  'usr/share/doc/libssl3t64/changelog.gz',
  'usr/share/doc/libssl3t64/copyright',
  'usr/share/lintian/overrides/libssl3t64',
];

export function pruneManagerOpenSsl(
  root = '/',
  sharedObjects = process.report.getReport().sharedObjects,
) {
  assert(
    !sharedObjects.some((file) => /\/(?:libssl|libcrypto)\.so/.test(file)),
    'Node depends on shared OpenSSL; refusing removal',
  );
  const base = realpathSync(root);
  const inside = (file) => path.join(base, file);
  const status = 'var/lib/dpkg/status.d/libssl3t64';
  const sums = status + '.md5sums';
  for (const file of [status, sums]) assert(lstatSync(inside(file)).isFile());
  const metadata = readFileSync(inside(status), 'utf8');
  assert.match(metadata, /^Package: libssl3t64$/m);
  assert.match(metadata, /^Architecture: amd64$/m);
  assert.match(metadata, /^Version: 3\.5\.7-1~deb13u3$/m);
  const files = readFileSync(inside(sums), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^[0-9a-f]{32}\s+(.+)$/.exec(line);
      assert(
        match && opensslFiles.includes(match[1]),
        'Unexpected OpenSSL package file',
      );
      return match[1];
    });
  assert.deepEqual([...files].sort(), [...opensslFiles].sort());
  // Validate every path before any deletion; never follow directory or file aliases.
  for (const file of [...files, status, sums]) {
    assert.equal(
      realpathSync(path.dirname(inside(file))),
      path.dirname(inside(file)),
    );
    assert(lstatSync(inside(file)).isFile());
  }
  for (const file of [...files, status, sums]) rmSync(inside(file));
  return { removedPackage: 'libssl3t64', sharedOpenSslLoaded: false };
}
