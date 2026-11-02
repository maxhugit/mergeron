import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLifecycle } from '../src/browser-lifecycle.mjs';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
function fixture() {
  let now = 0;
  let blocked = false;
  const calls = [];
  const component = {
    id: 'browser',
    canonicalName: 'test-browser',
    requiredNetworks: ['test-browser-control', 'test-browser-egress'],
    allowedImageRepositories: ['ghcr.io/maxhugit/mergeron-browser'],
    dns: ['1.1.1.1'],
  };
  const item = {
    Id: 'id',
    Image: 'image-id',
    Name: '/test-browser',
    Config: {
      Image: 'ghcr.io/maxhugit/mergeron-browser:edge',
      User: 'pwuser',
      Env: ['BROWSER_WS_PATH=' + 'a'.repeat(32)],
      Labels: {
        'io.mergeron.managed': 'true',
        'io.mergeron.component': 'browser',
        'io.mergeron.stack': 'test',
      },
      Healthcheck: { Test: ['CMD', 'check'] },
    },
    State: { Running: false, Health: { Status: 'starting' } },
    Mounts: [],
    HostConfig: {
      NetworkMode: 'test-browser-control',
      Dns: ['1.1.1.1'],
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true', 'seccomp=reviewed'],
    },
    NetworkSettings: {
      Networks: { 'test-browser-control': {}, 'test-browser-egress': {} },
    },
  };
  const docker = {
    inspectContainer: async () => item,
    inspectImage: async () => ({ Id: 'image-id' }),
    inspectNetwork: async (name) => ({
      Name: name,
      Driver: 'bridge',
      Internal: name.endsWith('-control'),
    }),
    startContainer: async () => {
      calls.push('start');
      item.State.Running = true;
    },
    stopContainer: async () => {
      calls.push('stop');
      item.State.Running = false;
    },
  };
  const lifecycle = new BrowserLifecycle({
    docker,
    manifest: { stack: 'test', components: [component] },
    now: () => now,
    blocked: () => blocked,
    env: {
      MERGERON_BROWSER_IDLE_SECONDS: '30',
      MERGERON_BROWSER_STARTUP_SECONDS: '10',
    },
  });
  return {
    lifecycle,
    item,
    docker,
    calls,
    advance: (ms) => {
      now += ms;
    },
    block: () => {
      blocked = true;
    },
  };
}
test('inspection is read-only; concurrent clients share one start and leases protect all users', async () => {
  const f = fixture();
  assert.equal((await f.lifecycle.status()).state, 'stopped');
  assert.deepEqual(f.calls, []);
  await Promise.all([
    f.lifecycle.lease({ owner }),
    f.lifecycle.lease({ owner: other }),
  ]);
  assert.deepEqual(f.calls, ['start']);
  assert.equal((await f.lifecycle.status()).state, 'starting');
  f.item.State.Health.Status = 'healthy';
  assert.equal((await f.lifecycle.status()).state, 'ready');
  await f.lifecycle.lease({ owner, release: true });
  f.advance(31_000);
  await f.lifecycle.tick();
  assert.deepEqual(f.calls, ['start']);
  await f.lifecycle.lease({ owner: other, release: true });
  f.advance(29_000);
  await f.lifecycle.tick();
  assert.equal(f.item.State.Running, true);
  f.advance(1000);
  await f.lifecycle.tick();
  assert.deepEqual(f.calls, ['start', 'stop']);
});
test('crashed clients expire and Manager restart grants an idle grace; maintenance blocks mutations', async () => {
  const f = fixture();
  await f.lifecycle.lease({ owner });
  f.advance(90_001);
  await f.lifecycle.tick();
  assert.equal(f.item.State.Running, true);
  f.advance(30_001);
  await f.lifecycle.tick();
  assert.equal(f.item.State.Running, false);
  f.block();
  await assert.rejects(f.lifecycle.lease({ owner }), /BUSY/);
  assert.deepEqual(f.calls, ['start', 'stop']);
  const g = fixture();
  g.item.State.Running = true;
  await g.lifecycle.tick();
  assert.deepEqual(g.calls, []);
  g.advance(30_001);
  g.block();
  await g.lifecycle.tick();
  assert.deepEqual(g.calls, []);
});
test('startup timeout is explicit and secrets are never returned', async () => {
  const f = fixture();
  await f.lifecycle.lease({ owner });
  f.advance(10_001);
  const status = await f.lifecycle.status();
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'BROWSER_RUNTIME_START_TIMEOUT');
  assert.ok(!JSON.stringify(status).includes('a'.repeat(32)));
  assert.ok(!JSON.stringify(status).includes(owner));
});
test('refuses altered isolation, ownership, image, networks, mounts and invalid policy without starting', async () => {
  for (const mutate of [
    (f) => (f.item.HostConfig.Privileged = true),
    (f) => (f.item.Config.User = 'root'),
    (f) => (f.item.Config.Labels['io.mergeron.stack'] = 'other'),
    (f) => f.item.Mounts.push({ Type: 'bind', Source: '/etc' }),
    (f) => (f.item.HostConfig.SecurityOpt = ['seccomp=unconfined']),
    (f) => (f.item.Config.Image = 'evil/browser:edge'),
    (f) =>
      (f.docker.inspectNetwork = async (name) => ({
        Name: name,
        Driver: 'bridge',
        Internal: false,
      })),
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.lifecycle.lease({ owner }), /ISOLATION/);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await assert.rejects(
    f.lifecycle.lease({ owner: 'arbitrary-container' }),
    /INVALID/,
  );
  assert.throws(
    () =>
      new BrowserLifecycle({
        manifest: { components: [] },
        env: { MERGERON_BROWSER_IDLE_SECONDS: 'NaN' },
      }),
    /INVALID_POLICY/,
  );
});

test('a released failed startup can be retried with a new bounded wait, without disabling health checks', async () => {
  const f = fixture();
  await f.lifecycle.lease({ owner });
  f.advance(10_001);
  assert.equal(
    (await f.lifecycle.status()).error,
    'BROWSER_RUNTIME_START_TIMEOUT',
  );
  await f.lifecycle.lease({ owner, release: true });
  assert.equal((await f.lifecycle.lease({ owner })).state, 'starting');
  f.advance(10_001);
  assert.equal((await f.lifecycle.status()).state, 'error');
  f.item.State.Health.Status = 'healthy';
  assert.equal((await f.lifecycle.status()).state, 'ready');
});

test('a maintenance operation accepted during inspection prevents the pending start', async () => {
  const f = fixture();
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  f.docker.inspectContainer = () => pending;
  const request = f.lifecycle.lease({ owner });
  await Promise.resolve();
  f.block();
  resolve(f.item);
  await assert.rejects(request, /BUSY/);
  assert.deepEqual(f.calls, []);
});
