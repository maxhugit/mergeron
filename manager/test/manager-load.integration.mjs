// Disposable Linux container only: real Manager HTTP, synthetic data, simulated
// Docker Unix endpoint. Never mount a real Docker socket, host state or secrets.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/fixture';
const variant = process.argv[2] ?? 'candidate';
assert.ok(['baseline', 'candidate'].includes(variant));
await fs.mkdir(root, { recursive: true });
assert.equal(await fs.realpath(root), root);
const state = join(root, 'synthetic');
const projectId = 'performance-fixture';
const runId = randomUUID();
const snapshotId = randomUUID();
const stack = 'manager-analysis';
const own = { 'io.mergeron.preview': runId, 'io.mergeron.stack': stack };
const updates = join(root, 'state/updates');
const operationId = randomUUID();
const backup = join(updates, operationId, 'backup');
await fs.mkdir(backup, { recursive: true });
for (let offset = 0; offset < 10000; offset += 32) {
  await Promise.all(
    Array.from({ length: Math.min(32, 10000 - offset) }, (_, i) =>
      fs.writeFile(join(backup, String(offset + i)), ''),
    ),
  );
}
await fs.writeFile(
  join(updates, `${operationId}.json`),
  JSON.stringify({
    id: operationId,
    stack,
    environment: 'development',
    status: 'succeeded',
    backupComplete: true,
    backupPolicy: 'full-v1',
  }),
);
const previews = join(root, 'state/previews');
await fs.mkdir(previews, { recursive: true });
await fs.writeFile(
  join(previews, `${runId}.json`),
  JSON.stringify({
    runId,
    previewId: randomUUID(),
    projectId,
    agentId: 'synthetic-agent',
    state: 'running',
    createdAt: Date.now(),
    expiresAt: null,
    objects: [{ id: 'fixture-runtime', component: 'preview-app' }],
    volumes: [],
    networks: [],
    entries: [],
    runtimeId: 'fixture-runtime',
    helperImage: 'sha256:' + 'b'.repeat(64),
    updateMode: 'hot',
    sourceSha: '0'.repeat(64),
  }),
);

// A near-limit, valid narrow USTAR snapshot: 48 MiB data, 14,505 entries.
// Stream fixture creation so the controller does not retain its entire archive.
const snapshot = join(
  state,
  'workspace/.mergeron-system',
  projectId,
  'previews',
  snapshotId,
  'source.tar',
);
await fs.mkdir(dirname(snapshot), { recursive: true });
const archive = await fs.open(snapshot, 'wx', 0o600);
const digest = createHash('sha256');
let snapshotBytes = 0;
async function append(buffer) {
  await archive.writeFile(buffer);
  digest.update(buffer);
  snapshotBytes += buffer.length;
}
function header(name, bytes, directory = false) {
  const buffer = Buffer.alloc(512);
  const field = (value, at, length) => buffer.write(value, at, length, 'ascii');
  const octal = (value, length) =>
    value.toString(8).padStart(length - 1, '0') + '\0';
  field(name, 0, 100);
  field(octal(directory ? 0o700 : 0o600, 8), 100, 8);
  field(octal(11002, 8), 108, 8);
  field(octal(11002, 8), 116, 8);
  field(octal(bytes, 12), 124, 12);
  field(octal(0, 12), 136, 12);
  field('        ', 148, 8);
  field(directory ? '5' : '0', 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  const checksum = buffer.reduce((sum, byte) => sum + byte, 0);
  field(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buffer;
}
try {
  await append(header('src/', 0, true));
  for (let n = 0; n < 14500; n++) await append(header(`src/module-${n}.ts`, 0));
  const block = Buffer.alloc(1024 ** 2, 7);
  for (let n = 0; n < 4; n++) {
    await append(header(`src/data-${n}.bin`, 12 * 1024 ** 2));
    for (let i = 0; i < 12; i++) await append(block);
  }
  await append(Buffer.alloc(1024));
} finally {
  await archive.close();
}
const sourceSha = digest.digest('hex');
assert.ok(snapshotBytes < 64 * 1024 ** 2);
// Incompressible synthetic data exercises gzip, durable writes and restoration.
const backupInput = join(root, 'archive-input/home');
await fs.mkdir(backupInput, { recursive: true });
const database = await fs.open(join(backupInput, 'database'), 'wx', 0o600);
const { randomBytes } = await import('node:crypto');
const dataHash = createHash('sha256');
try {
  for (let index = 0; index < 32; index++) {
    const data = randomBytes(1024 ** 2);
    dataHash.update(data);
    await database.writeFile(data);
  }
} finally {
  await database.close();
}
const dataSha = dataHash.digest('hex');

const dockerSocket = join(root, 'simulated-docker.sock');
let validatedSnapshots = 0;
const simulatedDocker = http.createServer((request, response) => {
  if (request.url === '/containers/fixture-runtime/json') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        Id: 'fixture-runtime',
        Config: { Labels: { ...own, 'io.mergeron.component': 'preview-app' } },
        State: { Running: true },
      }),
    );
  } else if (request.url.startsWith('/containers/json')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('[]');
  } else {
    // Stop after source validation. No runtime/volume can ever be created here.
    if (request.method === 'POST' && request.url === '/volumes/create')
      validatedSnapshots++;
    request.resume();
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'synthetic downstream refusal' }));
  }
});
await new Promise((resolve) => simulatedDocker.listen(dockerSocket, resolve));
const socketPath = join(root, 'manager.sock');
const codeRoot =
  variant === 'candidate' &&
  (await fs.stat(join(root, 'manager/src/server.mjs')).catch(() => null))
    ? join(root, 'manager')
    : '/opt/mergeron-manager';
if (codeRoot !== '/opt/mergeron-manager')
  await fs.cp('/opt/mergeron-manager/vendor', join(root, 'manager/vendor'), {
    recursive: true,
  });
const server = spawn(
  process.execPath,
  [new URL('./manager-load-server.mjs', import.meta.url).pathname],
  {
    env: {
      ...process.env,
      MERGERON_LOAD_CODE_ROOT: codeRoot,
      MERGERON_STACK_PREFIX: stack,
      MERGERON_STACK_ENVIRONMENT: 'development',
      MERGERON_MANAGER_SOCKET: socketPath,
      MERGERON_MANAGER_SOCKET_GID: '0',
      MERGERON_MANAGER_ADOPTION_PATH: join(root, 'state/adoption.json'),
      MERGERON_STATE_ROOT: state,
      MERGERON_MANAGER_HOST_STATE: state,
      MERGERON_DOCKER_SOCKET: dockerSocket,
      MERGERON_INSTALL_ENABLED: 'false',
      MERGERON_PREVIEWS_ENABLED: 'true',
      MERGERON_PREVIEW_DOMAIN: 'preview.example.org',
      MERGERON_PREVIEW_IMAGES: JSON.stringify({
        node: { image: 'example.org/node@sha256:' + 'a'.repeat(64) },
      }),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  },
);
server.stderr.resume(); // All input is synthetic; never export response/log bodies.
const report = {
  variant,
  realManager: true,
  realDockerSocket: false,
  syntheticFiles: 10000,
  snapshotBytes,
  snapshotEntries: 14505,
  phases: [],
};
async function request(path, body, deadlineMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: body ? 'POST' : 'GET',
        agent: false,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (response) => {
        let value = '';
        response.on('data', (chunk) => {
          value += chunk;
          if (value.length > 256 * 1024)
            req.destroy(Error('fixtureResponseLimit'));
        });
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, value: JSON.parse(value) });
          } catch {
            reject(Error('fixtureResponseInvalid'));
          }
        });
        response.on('error', reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(Error('fixtureDeadline')),
      deadlineMs,
    );
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function resources() {
  const result = {};
  for (const [file, keys] of [
    [
      'cpu.stat',
      ['usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec'],
    ],
    ['memory.events', ['max', 'oom', 'oom_kill']],
    ['memory.current', []],
    ['memory.peak', []],
  ]) {
    try {
      const data = await fs.readFile(`/sys/fs/cgroup/${file}`, 'utf8');
      if (!keys.length) result[file] = Number(data.trim());
      else
        for (const line of data.trim().split('\n')) {
          const [key, raw] = line.split(/\s+/);
          if (keys.includes(key)) result[`${file}.${key}`] = Number(raw);
        }
    } catch {
      /* Numeric diagnostics only; Linux cgroup v2 is optional locally. */
    }
  }
  try {
    const data = await fs.readFile(`/proc/${server.pid}/status`, 'utf8');
    result.managerRssBytes =
      Number(data.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  } catch {}
  return result;
}
async function phase(name, work) {
  const before = await resources();
  const samples = { health: [], status: [] };
  let peakRss = before.managerRssBytes ?? 0,
    done = false;
  const probing = (async () => {
    while (!done) {
      await Promise.all(
        [
          ['health', '/healthz'],
          ['status', '/v1/status'],
        ].map(async ([kind, path]) => {
          const begin = performance.now();
          try {
            const r = await request(path);
            samples[kind].push({
              ms: performance.now() - begin,
              ok: r.status === 200,
            });
          } catch {
            samples[kind].push({ ms: performance.now() - begin, ok: false });
          }
        }),
      );
      const observed = await resources();
      peakRss = Math.max(peakRss, observed.managerRssBytes ?? 0);
      await delay(100);
    }
  })();
  const begin = performance.now();
  try {
    await work();
  } finally {
    done = true;
    await probing;
  }
  const after = await resources();
  const stats = (values) => {
    const sorted = values.map((v) => Math.round(v.ms)).sort((a, b) => a - b);
    return {
      requests: values.length,
      failures: values.filter((v) => !v.ok).length,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms:
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      maxMs: sorted.at(-1),
    };
  };
  report.phases.push({
    name,
    elapsedMs: Math.round(performance.now() - begin),
    health: stats(samples.health),
    status: stats(samples.status),
    peakManagerRssBytes: peakRss,
    before,
    after,
  });
}
try {
  for (let n = 0; n < 100; n++) {
    if (server.exitCode !== null)
      throw Error('fixtureManagerExitedBeforeReady');
    try {
      if ((await request('/healthz')).status === 200) break;
    } catch {}
    if (n === 99) throw Error('fixtureManagerStartFailed');
    await delay(100);
  }
  await phase('idle', () => delay(3000));
  await phase('legacyBackupInventory', async () => {
    const deadline = Date.now() + 60000;
    let list;
    do {
      list = await request('/v1/backups');
      if (!list.value.sizesCalculating) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.equal(list.value.sizesCalculating, false);
    assert.equal(list.value.backups[0]?.sizeStatus, 'ready');
  });
  await phase('compressedBackupRoundtrip', async () => {
    const result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(Error('fixtureCompressionDeadline')),
        120000,
      );
      server.once('message', (value) => {
        clearTimeout(deadline);
        resolve(value);
      });
      server.send({ action: 'compress', dataSha });
    });
    assert.equal(result.ok, true);
    assert.equal(result.restored, true);
    assert.ok(result.bytes >= 32 * 1024 ** 2);
    report.compressedBytes = result.bytes;
  });
  await phase('nearLimitPreviewSnapshots', async () => {
    for (let n = 0; n < 3; n++) {
      const result = await request(
        '/v1/previews/sync',
        { runId, snapshotId, sourceSha },
        45000,
      );
      assert.equal(result.status, 409);
      assert.equal(result.value.error, 'PREVIEW_SYNC_FAILED');
      // This call occurs only after archive/hash validation, not on a malformed
      // snapshot, a missing file or an early ownership/cleanup failure.
      assert.equal(validatedSnapshots, n + 1);
    }
  });
  // Observe baseline without turning a reproduced latency failure into success.
  // Candidate is a regression gate: the normal health deadline stays unchanged.
  if (variant === 'candidate')
    for (const value of report.phases) {
      assert.equal(
        value.health.failures,
        0,
        `${value.name}: health deadline missed`,
      );
      assert.equal(
        value.status.failures,
        0,
        `${value.name}: status unavailable`,
      );
      for (const counter of ['max', 'oom', 'oom_kill'])
        if (`memory.events.${counter}` in value.after)
          assert.equal(value.after[`memory.events.${counter}`], 0, counter);
    }
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(
    JSON.stringify({
      ...report,
      failed: true,
      managerExitCode: server.exitCode,
    }),
  );
  throw error;
} finally {
  if (server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    const deadline = setTimeout(() => server.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(deadline);
  }
  await new Promise((resolve) => simulatedDocker.close(resolve));
}
