/** Synthetic packages for filesystem-only unit tests; never a distributable CLI. */
const fs = require('node:fs');
const path = require('node:path');
const runtime = require('./managed-cli.cjs');
function bundle(parent, revision = 1) {
  const directory = path.join(parent, `bundle-${revision}`);
  const native =
    'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
  const files = [
    native,
    'node_modules/@openai/codex-linux-x64/vendor/resource.json',
  ].map((name, i) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      i ? '{}' : '#!/bin/sh\nprintf "codex-cli 0.164.0\\n"\n',
      { mode: i ? 0o444 : 0o555 },
    );
    return {
      path: name,
      bytes: fs.statSync(file).size,
      sha256: runtime.hashFile(file),
      executable: !i,
    };
  });
  const data = {
    schema: 1,
    id: `0.164.0-mergeron.${revision}`,
    upstreamVersion: '0.164.0',
    revision,
    upstreamCommit: 'a'.repeat(40),
    patchSha256: 'b'.repeat(64),
    platform: 'linux',
    arch: 'x64',
    native,
    capabilities: [runtime.REQUIRED_CAPABILITY],
    files,
  };
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(data), {
    mode: 0o444,
  });
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
  return { directory, data: runtime.verify(directory) };
}
module.exports = { bundle };
