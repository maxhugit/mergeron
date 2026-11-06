import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  grantMonitor,
  publishMonitor,
} from '../src/update-monitor-journal.mjs';
import { createUpdateGateway } from '../src/update-monitor-gateway.mjs';
import {
  gatewaySpecification,
  gatewayRouting,
} from '../scripts/install-update-gateway.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-monitor-'));
  const app = http.createServer((req, res) => res.end('application'));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const gateway = createUpdateGateway({
    directory,
    hostname: 'mergeron.example.com',
    upstream: `http://127.0.0.1:${app.address().port}`,
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  t.after(async () => {
    gateway.closeAllConnections();
    app.closeAllConnections();
    await Promise.all([
      new Promise((r) => gateway.close(r)),
      new Promise((r) => app.close(r)),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: gateway.address().port,
          path,
          method: options.method ?? 'GET',
          headers: { Host: 'mergeron.example.com', ...options.headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () =>
            resolve({ status: res.statusCode, body, headers: res.headers }),
          );
        },
      );
      req.on('error', reject);
      req.end(options.body);
    });
  return { directory, app, request };
}
test('keeps HTTP monitoring available while application and manager are unavailable', async (t) => {
  const f = await fixture(t);
  const grant = await grantMonitor(f.directory);
  const op = {
    id: '123',
    phase: 'replacing',
    status: 'running',
    startedAt: new Date().toISOString(),
    events: [
      { at: new Date().toISOString(), phase: 'replacing', status: 'running' },
    ],
    secret: 'must-not-appear',
    containers: [{ Env: ['TOKEN=secret'] }],
  };
  assert.equal((await f.request('/')).body, 'application');
  assert.equal((await f.request('/_mergeron-update/status')).status, 401);
  assert.equal(
    (
      await f.request('/_mergeron-update/session', {
        method: 'POST',
        body: grant.token,
        headers: { Origin: 'https://attacker.invalid' },
      })
    ).status,
    403,
  );
  const session = await f.request('/_mergeron-update/session', {
    method: 'POST',
    body: grant.token,
    headers: { Origin: 'https://mergeron.example.com' },
  });
  assert.equal(session.status, 200);
  assert.match(
    session.headers['set-cookie'][0],
    /Secure; HttpOnly; SameSite=Strict/,
  );
  const headers = { Cookie: `mergeron_update=${grant.token}` };
  await publishMonitor(f.directory, op);
  await new Promise((r) => f.app.close(r));
  for (const phase of [
    'replacing',
    'managerReplacing',
    'managerChecking',
    'complete',
  ]) {
    await publishMonitor(f.directory, {
      ...op,
      phase,
      status: phase === 'complete' ? 'succeeded' : 'running',
    });
    for (let n = 0; n < 10; n++) {
      assert.equal(
        (await f.request('/', { headers: { Accept: 'text/html' } })).status,
        200,
      );
      const state = await f.request('/_mergeron-update/status', { headers });
      assert.equal(state.status, 200);
      assert.equal(JSON.parse(state.body).operation.phase, phase);
      assert(!state.body.includes('secret'));
      assert(!state.body.includes('TOKEN'));
    }
  }
  assert(
    !(await readFile(join(f.directory, 'access.json'), 'utf8')).includes(
      grant.token,
    ),
  );
});
test('fails closed for unknown hosts, invalid tokens, traversal and expired grants', async (t) => {
  const f = await fixture(t);
  const grant = await grantMonitor(f.directory, Date.now() - 7 * 3600000);
  assert.equal(
    (
      await f.request('/_gateway-health', {
        headers: { Host: 'attacker.invalid' },
      })
    ).status,
    421,
  );
  assert.equal(
    (
      await f.request('/_mergeron-update/status', {
        headers: { Cookie: `mergeron_update=${grant.token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.request('/_mergeron-update/../access.json')).status,
    404,
  );
  assert.equal(
    (
      await f.request('/_mergeron-update/session', {
        method: 'POST',
        body: 'a'.repeat(129),
        headers: { Origin: 'https://mergeron.example.com' },
      })
    ).status,
    413,
  );
});
test('gateway profile is read-only, unprivileged and has neither Docker nor private journal mounts', () => {
  const config = {
    stack: 'mergeron-dev',
    hostname: 'dev.example.com',
    image: `ghcr.io/maxhugit/mergeron-manager@sha256:${'a'.repeat(64)}`,
    stateRoot: '/srv/dev',
    network: 'proxy',
  };
  const spec = gatewaySpecification(config);
  assert.equal(spec.User, '65532:65532');
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(spec.HostConfig.Binds, [
    '/srv/dev/manager-state/maintenance:/monitor:ro',
  ]);
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert(spec.Healthcheck.Test.includes('/nodejs/bin/node'));
  const route = gatewayRouting(config);
  assert.equal(
    route.http.services['mergeron-dev-continuous'].loadBalancer.servers.length,
    2,
  );
  assert.throws(() =>
    gatewaySpecification({ ...config, image: 'attacker:latest' }),
  );
});
