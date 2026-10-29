const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const runtime = require('./managed-cli.cjs');
const { bundle } = require('./testing.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, ...bundle(directory) };
}
test('verifies full package identity and all version-matched resources', (t) => {
  const value = fixture(t);
  assert.equal(runtime.verify(value.directory).id, '0.164.0-mergeron.1');
});
test('integrity cache notices same-size native corruption', (t) => {
  const { directory, data } = fixture(t);
  runtime.verify(directory);
  const file = path.join(directory, data.native);
  const original = fs.readFileSync(file);
  fs.chmodSync(file, 0o755);
  original[0] = 45;
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o555);
  assert.throws(() => runtime.verify(directory), /Integrity/);
});
test('rejects corrupted sidecars, not only the native executable', (t) => {
  const { directory, data } = fixture(t);
  const file = path.join(directory, data.files[1].path);
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, '[]');
  fs.chmodSync(file, 0o444);
  assert.throws(() => runtime.verify(directory), /Integrity/);
});
test('rejects unapproved manifest, path traversal and symlinked resources', (t) => {
  const { directory, data } = fixture(t);
  assert.throws(() => runtime.verify(directory, 'f'.repeat(64)), /Integrity/);
  for (const name of ['../escape', '/root/file', 'a/../b', 'a\\b', './file'])
    assert.throws(() => runtime.relativeFile(name), /Integrity/);
  const file = path.join(directory, data.files[1].path);
  fs.unlinkSync(file);
  fs.symlinkSync('/etc/passwd', file);
  assert.throws(() => runtime.verify(directory), /Integrity/);
});
test('rejects swapped helper aliases', (t) => {
  const { directory } = fixture(t);
  const file = path.join(directory, 'helpers/apply_patch');
  fs.unlinkSync(file);
  fs.symlinkSync('/bin/sh', file);
  assert.throws(() => runtime.verify(directory), /Integrity/);
});
test('custom selections without an approval never fall back to a legacy CLI', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(runtime.root(directory), { recursive: true });
  const file = path.join(runtime.root(directory), 'selection.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: '0.164.0-mergeron.1', previous: null }),
  );
  assert.throws(() => runtime.selected(directory), /Integrity/);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => runtime.selected(directory));
});
