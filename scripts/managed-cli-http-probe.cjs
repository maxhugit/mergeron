/** Only used against the disposable network-none application in the CI smoke. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runtime = require('/app/runtime/managed-cli.cjs');
const home = process.env.CODEX_HOME || '/home/codex/.codex';
async function api(route, body) {
  const response = await fetch(`http://127.0.0.1:8172/api/codex/cli/${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.WEBUI_API_KEY}`,
      'x-webui-auth-source': 'service',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(210_000),
  });
  return { status: response.status, body: await response.json() };
}
async function main() {
  if (process.argv[2] === 'persisted') {
    assert(runtime.selected(home).includes('-mergeron.'));
    assert.equal(
      (
        await api('update', {
          expectedVersion: '0.164.0',
          targetVersion: '9.9.9',
        })
      ).status,
      409,
    );
    console.log(
      'PASS: selection and official-update protection survived restart',
    );
    return;
  }
  const release = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        socketPath: '/run/mergeron-manager/manager.sock',
        path: '/v1/codex-cli',
      },
      (response) => {
        let raw = '';
        response.on('data', (part) => (raw += part));
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
  });
  const installed = await api('managed', {
    releaseId: release.id,
    manifestSha256: release.manifestSha256,
    expectedSelection: null,
  });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal(runtime.selection(home).version, release.id);
  assert(runtime.selected(home).includes(release.id));
  assert.equal(
    (
      await api('update', {
        expectedVersion: '0.164.0',
        targetVersion: '9.9.9',
      })
    ).status,
    409,
  );
  assert.equal(
    (await api('rollback', { expectedVersion: release.id })).status,
    409,
  );
  const directory = path.dirname(runtime.binary(home, release.id));
  const manifest = runtime.verify(directory, release.manifestSha256);
  const item = manifest.files.find(
    (f) => f.path !== manifest.native && f.bytes < 4096,
  );
  assert(item, 'small sidecar needed for integrity regression');
  const file = path.join(directory, item.path);
  const original = fs.readFileSync(file);
  try {
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, 'tampered fixture resource');
    fs.chmodSync(file, 0o444);
    assert.throws(() => runtime.selected(home), /Integrity/);
    const dispatched = spawnSync(
      '/usr/local/bin/codex-cli-dispatch',
      ['--version'],
      { env: { ...process.env, CODEX_HOME: home } },
    );
    assert.equal(
      dispatched.status,
      78,
      'dispatcher must not fall back to any legacy CLI',
    );
  } finally {
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, original);
    fs.chmodSync(file, 0o444);
  }
  runtime.selected(home);
  console.log(
    `PASS: Manager installation, idle activation, update/rollback guards and full-resource integrity; release=${release.id}`,
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
