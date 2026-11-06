import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneManagerZlib } from '../../scripts/prune-manager-zlib.mjs';

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'manager-runtime-'));
  const file = 'usr/lib/x86_64-linux-gnu/libz.so.1.3.1';
  const status = path.join(root, 'var/lib/dpkg/status.d/zlib1g');
  try {
    mkdirSync(path.dirname(status), { recursive: true });
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(
      status,
      'Package: zlib1g\nArchitecture: amd64\nVersion: fixture\n',
    );
    writeFileSync(status + '.md5sums', '0'.repeat(32) + '  ' + file + '\n');
    writeFileSync(path.join(root, file), 'unused shared library');
    symlinkSync(
      'libz.so.1.3.1',
      path.join(root, 'usr/lib/x86_64-linux-gnu/libz.so.1'),
    );
    writeFileSync(path.join(root, 'private-canary'), 'preserve');
    run({ root, file, status });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('removes actual package files and metadata, preserving unrelated runtime contents', () =>
  fixture(({ root, file, status }) => {
    assert.equal(pruneManagerZlib(root, []).removedPackage, 'zlib1g');
    for (const entry of [
      file,
      'usr/lib/x86_64-linux-gnu/libz.so.1',
      status,
      status + '.md5sums',
    ])
      assert(
        !existsSync(path.isAbsolute(entry) ? entry : path.join(root, entry)),
      );
    assert(existsSync(path.join(root, 'private-canary')));
  }));
test('refuses removal if Node loads shared zlib', () =>
  fixture(({ root, file }) => {
    assert.throws(
      () => pruneManagerZlib(root, ['/lib/x86_64-linux-gnu/libz.so.1']),
      /depends/,
    );
    assert(existsSync(path.join(root, file)));
  }));
test('refuses unexpected inventory before deleting any library', () =>
  fixture(({ root, file, status }) => {
    writeFileSync(
      status + '.md5sums',
      '0'.repeat(32) + '  ../../../private-canary\n',
    );
    assert.throws(() => pruneManagerZlib(root, []), /Unexpected/);
    assert(existsSync(path.join(root, file)));
    assert(existsSync(status));
  }));
test('refuses an unexpected ABI link before deleting any library', () =>
  fixture(({ root, file }) => {
    const link = path.join(root, 'usr/lib/x86_64-linux-gnu/libz.so.1');
    rmSync(link);
    symlinkSync('../../../private-canary', link);
    assert.throws(() => pruneManagerZlib(root, []));
    assert(existsSync(path.join(root, file)));
  }));
