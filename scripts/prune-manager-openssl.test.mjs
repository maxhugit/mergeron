import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { opensslFiles, pruneManagerOpenSsl } from './prune-manager-openssl.mjs';
const status = 'var/lib/dpkg/status.d/libssl3t64';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'manager-openssl-'));
  for (const name of [...opensslFiles, status, status + '.md5sums']) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), 'fixture');
  }
  writeFileSync(
    path.join(root, status),
    'Package: libssl3t64\nArchitecture: amd64\nVersion: 3.5.7-1~deb13u3\n',
  );
  writeFileSync(
    path.join(root, status + '.md5sums'),
    opensslFiles.map((p) => '0'.repeat(32) + '  ' + p).join('\n'),
  );
  return root;
}
for (const mode of ['valid', 'loaded', 'unexpected', 'symlink'])
  test(`OpenSSL package pruning: ${mode}`, () => {
    const root = fixture();
    try {
      if (mode === 'loaded')
        assert.throws(() => pruneManagerOpenSsl(root, ['/lib/libssl.so.3']));
      if (mode === 'unexpected') {
        writeFileSync(
          path.join(root, status + '.md5sums'),
          '0'.repeat(32) + '  ../outside',
        );
        assert.throws(() => pruneManagerOpenSsl(root, []));
      }
      if (mode === 'symlink') {
        rmSync(path.join(root, opensslFiles[0]));
        symlinkSync('/etc/passwd', path.join(root, opensslFiles[0]));
        assert.throws(() => pruneManagerOpenSsl(root, []));
      }
      if (mode === 'valid') {
        pruneManagerOpenSsl(root, []);
        for (const p of [...opensslFiles, status, status + '.md5sums'])
          assert(!existsSync(path.join(root, p)));
      } else assert(existsSync(path.join(root, status)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
