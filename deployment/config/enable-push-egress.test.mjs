import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurePushEgress, withPushEgress } from './enable-push-egress.mjs';
const template = await readFile(new URL('./squid.conf', import.meta.url), 'utf8');
const legacy = template.replace(/^acl allowed_domains dstdomain (fcm.googleapis.com|\.push.apple.com|\.push.services.mozilla.com|\.notify.windows.com)\n/gm, '');
test('only adds exact provider grants, preserves custom rules and all network denials, and is idempotent', () => {
  const source = legacy.replace('cache deny all', 'acl custom dstdomain custom.example.test\ncache deny all');
  const result = withPushEgress(source);
  assert.equal(result.replace(/^acl allowed_domains dstdomain (fcm.googleapis.com|\.push.apple.com|\.push.services.mozilla.com|\.notify.windows.com)\n/gm, ''), source);
  assert.equal(withPushEgress(result), result);
  assert.throws(() => withPushEgress(source.replace('http_access deny private_ipv4', '')), /Unrecognized/);
  assert.throws(() => withPushEgress(`http_access allow all\n${source}`), /Unexpected/);
});
test('checks without writing, applies explicitly with a recoverable backup, and refuses symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'push-egress-'));
  try {
    const path = join(directory, 'squid.conf'); await writeFile(path, legacy);
    assert.deepEqual(await configurePushEgress(path), { changed: false, needed: true }); assert.equal(await readFile(path, 'utf8'), legacy);
    const result = await configurePushEgress(path, true); assert.equal(result.changed, true); assert.equal(await readFile(result.backupPath, 'utf8'), legacy);
    assert.deepEqual(await configurePushEgress(path, true), { changed: false, needed: false });
    const linked = join(directory, 'linked'); await symlink(path, linked); await assert.rejects(configurePushEgress(linked, true));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
