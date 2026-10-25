import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
function run(extra = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'promotion-test-'));
  try {
    const log = path.join(temporary, 'calls');
    const result = spawnSync(
      'bash',
      [path.join(root, 'promote-image-pair.sh')],
      {
        env: {
          ...process.env,
          PATH: `${root}/test-fixtures/promotion:${process.env.PATH}`,
          PROMOTION_LOG: log,
          APP_SOURCE_IMAGE: 'registry/app:sha-new',
          APP_SOURCE_DIGEST: 'sha256:new-app',
          APP_TARGET_TAGS: 'registry/app:edge',
          MANAGER_SOURCE_IMAGE: 'registry/manager:sha-new',
          MANAGER_SOURCE_DIGEST: 'sha256:new-manager',
          MANAGER_TARGET_TAGS: 'registry/manager:edge',
          ...extra,
        },
        encoding: 'utf8',
      },
    );
    return { ...result, calls: readFileSync(log, 'utf8') };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
test('promotes both verified digests after taking snapshots', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.calls,
    /create --tag registry\/app:edge registry\/app@sha256:new-app/,
  );
  assert.match(
    result.calls,
    /create --tag registry\/manager:edge registry\/manager@sha256:new-manager/,
  );
});
test('restores both prior channel digests if the second promotion fails', () => {
  const result = run({ FAIL_MANAGER: '1' });
  assert.equal(result.status, 1);
  assert.match(
    result.calls,
    /create --tag registry\/app:edge registry\/app@sha256:previous/,
  );
  assert.match(
    result.calls,
    /create --tag registry\/manager:edge registry\/manager@sha256:previous/,
  );
});
test('does not mutate channel tags when their previous state cannot be read', () => {
  const result = run({ FAIL_SNAPSHOT: '1' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.calls, /imagetools create/);
});
