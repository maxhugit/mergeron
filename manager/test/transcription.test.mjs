import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ManagedTranscription,
  TRANSCRIPTION_REPOSITORY,
} from '../src/transcription.mjs';
const owner = '12345678-1234-4234-8234-123456789012';
function fixture(env = { MERGERON_TRANSCRIPTION_ENABLED: 'true' }) {
  let now = 0,
    container = null,
    creates = 0,
    starts = 0,
    stops = 0,
    pulls = 0;
  const image = {
    Id: 'sha256:' + 'a'.repeat(64),
    RepoDigests: [TRANSCRIPTION_REPOSITORY + '@sha256:' + 'b'.repeat(64)],
    Config: { Labels: {} },
  };
  const missing = () => Object.assign(Error('missing'), { statusCode: 404 });
  const docker = {
    async inspectContainer() {
      if (!container) throw missing();
      return container;
    },
    async inspectImage() {
      return image;
    },
    async pullImage() {
      pulls++;
    },
    async inspectNetwork() {
      return { Internal: true, Driver: 'bridge' };
    },
    async createContainer(name, spec) {
      creates++;
      container = {
        Id: 'owned',
        Name: '/' + name,
        Image: image.Id,
        Config: { ...spec },
        HostConfig: spec.HostConfig,
        Mounts: [],
        NetworkSettings: { Networks: { 'test-isolated': {} } },
        State: { Running: false, Health: { Status: 'healthy' } },
      };
      return { Id: 'owned' };
    },
    async startContainer() {
      starts++;
      container.State.Running = true;
    },
    async stopContainer() {
      stops++;
      container.State.Running = false;
    },
    async inspectDistribution() {
      return { Descriptor: { digest: 'sha256:' + 'b'.repeat(64) } };
    },
  };
  const service = new ManagedTranscription({
    docker,
    env,
    manifest: {
      stack: 'test',
      environment: 'development',
      networks: [{ id: 'isolated', name: 'test-isolated', internal: true }],
    },
    configuration: { stateRoot: '/data', hostStatePath: '/host' },
    inventory: async () => ({
      components: [
        { id: 'application', containerId: 'app', adoption: 'managed' },
      ],
    }),
    now: () => now,
  });
  return {
    service,
    docker,
    get container() {
      return container;
    },
    counts: () => ({ creates, starts, stops, pulls }),
    time: (value) => (now = value),
  };
}
test('disabled service never creates or starts a container', async () => {
  const f = fixture({});
  await assert.rejects(f.service.lease({ owner }), /DISABLED/);
  await f.service.tick();
  assert.deepEqual(f.counts(), { creates: 0, starts: 0, stops: 0, pulls: 0 });
});
test('concurrent requests share start; only private lease reveals transport; idle stop and stopped update discovery do not wake it', async () => {
  const f = fixture();
  await Promise.all([
    f.service.lease({ owner }),
    f.service.lease({ owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
  ]);
  await f.service.task;
  const status = await f.service.status();
  assert.equal(status.state, 'ready');
  assert.equal(JSON.stringify(status).includes('transport'), false);
  const lease = await f.service.lease({ owner });
  assert.match(lease.transport.token, /^[a-f0-9]{64}$/);
  assert.equal(lease.transport.url, 'http://test-transcription:8090');
  assert.equal(f.counts().creates, 1);
  assert.equal(f.counts().starts, 1);
  assert.equal(f.container.HostConfig.ReadonlyRootfs, true);
  assert.equal(f.container.HostConfig.Memory, 6 * 1024 ** 3);
  assert.equal(f.container.HostConfig.NanoCpus, 4e9);
  assert.deepEqual(f.container.HostConfig.CapDrop, ['ALL']);
  assert.equal(f.container.HostConfig.PortBindings, undefined);
  f.time(91_000);
  await f.service.tick();
  f.time(392_000);
  await f.service.tick();
  assert.equal(f.counts().stops, 1);
  assert.equal((await f.service.updates()).updateAvailable, false);
  assert.equal(f.counts().starts, 1);
});
test('alien container is never started or stopped', async () => {
  const f = fixture();
  await f.service.lease({ owner });
  await f.service.task;
  f.container.Config.Labels['io.mergeron.stack'] = 'other';
  assert.equal((await f.service.status()).error, 'TRANSCRIPTION_OWNERSHIP');
  f.time(600_000);
  await f.service.tick();
  f.time(1000_000);
  await assert.rejects(f.service.tick(), /OWNERSHIP/);
  assert.equal(f.counts().stops, 0);
});
test('failed network validation is visible, and no container is created', async () => {
  const f = fixture();
  f.docker.inspectNetwork = async () => ({ Internal: false, Driver: 'bridge' });
  await f.service.lease({ owner });
  await f.service.task;
  assert.equal((await f.service.status()).error, 'TRANSCRIPTION_NETWORK');
  assert.equal((await f.service.status()).state, 'error');
  assert.equal(f.counts().creates, 0);
});
test('lease arriving during idle inspection prevents stopping', async () => {
  const f = fixture();
  await f.service.lease({ owner });
  await f.service.task;
  await f.service.lease({ owner, release: true });
  f.time(301_000);
  let resolve;
  const inspect = f.docker.inspectContainer;
  f.docker.inspectContainer = () => new Promise((r) => (resolve = r));
  const pending = f.service.tick();
  f.service.leases.set(owner, 999999);
  resolve(f.container);
  await pending;
  f.docker.inspectContainer = inspect;
  assert.equal(f.counts().stops, 0);
});

test('unhealthy running worker is reported rather than restarted on every renewal', async () => {
  const f = fixture();
  await f.service.lease({ owner });
  await f.service.task;
  f.container.State.Health.Status = 'unhealthy';
  const state = await f.service.lease({ owner });
  assert.equal(state.state, 'error');
  assert.equal(f.service.task, null);
  assert.equal(f.counts().starts, 1);
});
