import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSocketDirectory } from '../src/socket-directory.mjs';

test('repairs a pre-existing socket directory and reapplies the configured group on restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'manager-socket-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'manager-run');
  await mkdir(directory, { mode: 0o700 });
  const ownership = [];
  const operations = {
    mkdir,
    lstat,
    chmod,
    chown: async (...args) => ownership.push(args),
  };
  await prepareSocketDirectory(directory, 11002, operations);
  assert.equal((await lstat(directory)).mode & 0o777, 0o750);
  await prepareSocketDirectory(directory, 11003, operations);
  assert.deepEqual(ownership, [
    [directory, 0, 11002],
    [directory, 0, 11003],
  ]);
});

test('rejects a symbolic-link socket directory without changing its target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'manager-socket-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  const link = join(root, 'manager-run');
  await symlink(target, link);
  await assert.rejects(
    prepareSocketDirectory(link, 11002),
    /Invalid Manager socket directory/,
  );
  assert.equal((await lstat(target)).mode & 0o777, 0o700);
});

test('does not start with invalid group or failed ownership repair', async () => {
  await assert.rejects(
    prepareSocketDirectory('/unused', -1),
    /Invalid Manager socket group/,
  );
  await assert.rejects(
    prepareSocketDirectory('/unused', 11002, {
      mkdir: async () => {},
      lstat: async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
      chown: async () => {
        throw new Error('EPERM');
      },
      chmod: async () => assert.fail('must not mask failed ownership'),
    }),
    /EPERM/,
  );
});
