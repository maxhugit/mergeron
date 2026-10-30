import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { previewCommand } from '../src/preview-command.mjs';
import storage from '../../runtime/preview-storage.cjs';

function run(profile) {
  const root = mkdtempSync(join(tmpdir(), 'mergeron-preview-command-'));
  try {
    return spawnSync('/bin/sh', ['-c', previewCommand(profile)], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.keys(storage.cacheEnvironment).map((key) => [
            key,
            join(root, key),
          ]),
        ),
        TMPDIR: root,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const phase of ['install', 'build']) {
  test(`a failed ${phase} AND-list cannot run any following phase`, () => {
    const result = run({
      install: 'printf installed',
      build: 'printf built',
      start: 'printf SERVER_STARTED',
      [phase]: "sh -c 'exit 7' && printf UNREACHABLE",
    });
    assert.equal(result.status, 7);
    assert.doesNotMatch(result.stdout, /UNREACHABLE|SERVER_STARTED/);
    if (phase === 'install') assert.doesNotMatch(result.stdout, /built/);
  });
}
test('a simple failing command still stops immediately within a phase', () => {
  const result = run({
    install: 'false\nprintf UNREACHABLE',
    build: '',
    start: 'printf SERVER_STARTED',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});
test('successful phases retain exported variables and their working directory', () => {
  const result = run({
    install: 'export PREVIEW_PHASE_TEST=retained\ncd "$TMPDIR"',
    build: '[ "$PWD" = "$TMPDIR" ] && [ "$PREVIEW_PHASE_TEST" = retained ]',
    start: 'printf SERVER_STARTED',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SERVER_STARTED');
});
test('empty optional phases and a trailing comment remain valid', () => {
  const result = run({
    install: '',
    build: 'true # build',
    start: 'printf ok',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok');
});
