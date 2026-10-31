// Run only through smoke-test-manager-health.sh in a disposable, capped,
// network-none container. No Docker socket, real backups or credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/fixture';
const id = randomUUID();
const directory = join(root, 'state/updates', id);
const backup = join(directory, 'backup');
await mkdir(backup, { recursive: true });
for (let n = 0; n < 10000; n += 32)
  await Promise.all(
    Array.from({ length: Math.min(32, 10000 - n) }, (_, i) =>
      writeFile(join(backup, String(n + i)), ''),
    ),
  );
await writeFile(
  join(root, 'state/updates', `${id}.json`),
  JSON.stringify({
    id,
    stack: 'health-fixture',
    environment: 'development',
    status: 'succeeded',
    backupComplete: true,
    backupPolicy: 'full-v1',
  }),
);
const socketPath = join(root, 'manager.sock');
const environment = {
  ...process.env,
  MERGERON_STACK_PREFIX: 'health-fixture',
  MERGERON_STACK_ENVIRONMENT: 'development',
  MERGERON_MANAGER_SOCKET: socketPath,
  MERGERON_MANAGER_SOCKET_GID: '0',
  MERGERON_MANAGER_ADOPTION_PATH: join(root, 'state/adoption.json'),
  MERGERON_STATE_ROOT: join(root, 'data'),
  MERGERON_MANAGER_HOST_STATE: join(root, 'data'),
  MERGERON_DOCKER_SOCKET: join(root, 'no-docker.sock'),
  MERGERON_INSTALL_ENABLED: 'false',
};
let server;
let failures = 0;
let probes = 0;
async function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (data) => {
        body += data;
        if (body.length > 16384) req.destroy(Error('response too large'));
      });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200);
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    const deadline = setTimeout(
      () => req.destroy(Error('request timeout')),
      2500,
    );
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end();
  });
}
async function start() {
  server = spawn(process.execPath, ['src/server.mjs'], {
    env: environment,
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await request('/healthz');
      return;
    } catch {
      await delay(100);
    }
  }
  throw Error('real Manager did not start');
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  const deadline = setTimeout(() => server.kill('SIGKILL'), 1000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}
async function probe() {
  const child = spawn(process.execPath, ['src/healthcheck.mjs'], {
    env: environment,
    stdio: 'ignore',
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  clearTimeout(deadline);
  probes++;
  if (code !== 0) failures++;
}
try {
  await start();
  let list = await request('/v1/backups');
  assert.equal(list.sizesCalculating, true);
  const deadline = Date.now() + 60000;
  while (list.sizesCalculating && Date.now() < deadline) {
    await probe();
    list = await request('/v1/backups');
  }
  assert.equal(list.sizesCalculating, false);
  assert.equal(list.backups[0].sizeStatus, 'ready');
  assert.equal(failures, 0);
  assert.ok(probes > 0);
  const cache = join(directory, 'backup-size.json');
  assert.equal(
    JSON.parse(await readFile(cache, 'utf8')).bytes,
    list.totalSizeBytes,
  );
  const before = await stat(cache);
  await stop();
  await start();
  // Poll only metadata: a validated persisted cache is reused after restart.
  for (let attempt = 0; attempt < 40; attempt++) {
    list = await request('/v1/backups');
    if (!list.sizesCalculating) break;
    await delay(100);
  }
  assert.equal(list.backups[0].sizeStatus, 'ready');
  assert.equal((await stat(cache)).mtimeMs, before.mtimeMs);
  console.log(
    JSON.stringify({
      realManager: true,
      syntheticFiles: 10000,
      probes,
      failures,
      cachedAfterRestart: true,
    }),
  );
} finally {
  await stop();
}
