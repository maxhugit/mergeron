/** Build-time only: package the tested native binary and version-matched sidecars. */
const fs = require('node:fs');
const path = require('node:path');
const runtime = require('../runtime/managed-cli.cjs');
const directory = path.resolve(process.argv[2]);
const patch = process.argv[3];
const native =
  'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const files = [];
function walk(base, prefix = '') {
  for (const item of fs.readdirSync(base, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    const file = path.join(base, item.name);
    if (item.isDirectory()) walk(file, name);
    else {
      if (!item.isFile() || item.isSymbolicLink())
        throw new Error('Unexpected runtime asset');
      const executable = Boolean(fs.statSync(file).mode & 0o111);
      fs.chmodSync(file, executable ? 0o555 : 0o444);
      files.push({
        path: name,
        bytes: fs.statSync(file).size,
        sha256: runtime.hashFile(file),
        executable,
      });
    }
  }
}
walk(directory);
fs.writeFileSync(
  path.join(directory, 'release.json'),
  JSON.stringify({
    schema: 1,
    id: '0.164.0-mergeron.1',
    upstreamVersion: '0.164.0',
    revision: 1,
    upstreamCommit: '6aaac694803004a63c6f393d153c96d22521a6b9',
    patchSha256: runtime.hashFile(patch),
    platform: 'linux',
    arch: 'x64',
    capabilities: [runtime.REQUIRED_CAPABILITY],
    native,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  }) + '\n',
  { mode: 0o444 },
);
fs.symlinkSync(native, path.join(directory, 'codex'));
fs.mkdirSync(path.join(directory, 'helpers'));
for (const name of [
  'codex',
  'apply_patch',
  'applypatch',
  'codex-execve-wrapper',
  'codex-linux-sandbox',
])
  fs.symlinkSync('../codex', path.join(directory, 'helpers', name));
const verified = runtime.verify(directory);
console.log(
  JSON.stringify({
    id: verified.id,
    manifestSha256: verified.manifestSha256,
    nativeSha256: verified.files.find((entry) => entry.path === verified.native)
      .sha256,
    files: verified.files.length,
  }),
);
