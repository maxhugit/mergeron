import { TransactionalUpdater } from '../src/updater.mjs';
import { publishMonitor } from '../src/update-monitor-journal.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagerReplacement } from '../src/manager-replacement.mjs';
import { runManagerReplacement } from '../src/manager-replacement-worker.mjs';
import { GlobalUpdateCoordinator } from '../src/global-update-coordinator.mjs';
const oldImage = 'sha256:' + 'a'.repeat(64),
  nextImage = 'sha256:' + 'b'.repeat(64),
  target = 'ghcr.io/maxhugit/mergeron-manager@sha256:' + 'c'.repeat(64);
class Docker {
  constructor() {
    this.values = new Map();
    this.calls = [];
    this.failNew = false;
    this.values.set('old', {
      Id: 'old',
      Name: '/mergeron-dev-manager',
      Image: oldImage,
      State: { Running: true, Health: { Status: 'healthy' } },
      Config: {
        Image: oldImage,
        Env: ['SECRET=private'],
        Labels: {
          'io.mergeron.stack': 'mergeron-dev',
          'io.mergeron.component': 'manager',
          'io.mergeron.managed': 'true',
        },
        Healthcheck: { Test: ['CMD', 'health'] },
      },
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        Binds: ['/host/state:/host-state'],
      },
      NetworkSettings: { Networks: {} },
      Mounts: [
        {
          Destination: '/var/lib/mergeron-manager',
          Source: '/host/state/manager-state',
          Type: 'bind',
          RW: true,
        },
        {
          Destination: '/var/run/docker.sock',
          Source: '/var/run/docker.sock',
          Type: 'bind',
        },
        {
          Destination: '/run/mergeron-manager',
          Source: '/host/state/manager-run',
          Type: 'bind',
        },
      ],
    });
  }
  async inspectContainer(id) {
    const value =
      this.values.get(id) ??
      [...this.values.values()].find((v) => v.Name === '/' + id);
    if (!value)
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    return structuredClone(value);
  }
  async pullImage(image) {
    this.calls.push(['pull', image]);
  }
  async inspectImage(reference) {
    return {
      Id: reference === oldImage ? oldImage : nextImage,
      Config: { Labels: { 'io.mergeron.continuous-updates': '1' } },
    };
  }
  async createContainer(name, spec) {
    const id = 'new-' + this.values.size;
    this.calls.push(['create', name, structuredClone(spec)]);
    this.values.set(id, {
      Id: id,
      Name: '/' + name,
      Image: nextImage,
      Config: spec,
      HostConfig: spec.HostConfig,
      State: { Running: false, Health: { Status: 'starting' } },
      NetworkSettings: { Networks: {} },
    });
    return { Id: id };
  }
  async startContainer(id) {
    this.calls.push(['start', id]);
    const value = this.values.get(id);
    value.State = {
      Running: true,
      Health: {
        Status: this.failNew && id !== 'old' ? 'unhealthy' : 'healthy',
      },
    };
  }
  async stopContainer(id) {
    this.calls.push(['stop', id]);
    this.values.get(id).State.Running = false;
  }
  async renameContainer(id, name) {
    if (
      [...this.values.values()].some(
        (v) => v.Id !== id && v.Name === '/' + name,
      )
    )
      throw new Error('name occupied');
    this.calls.push(['rename', id, name]);
    this.values.get(id).Name = '/' + name;
  }
  async removeContainer(id) {
    this.calls.push(['remove', id]);
    this.values.delete(id);
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'manager-replacement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docker = new Docker();
  const manager = new ManagerReplacement({
    docker,
    stack: 'mergeron-dev',
    directory,
    enabled: true,
  });
  const plan = await manager.plan(target);
  const handle = await manager.launch(plan, 'operation');
  await mkdir(join(directory, 'updates'));
  await writeFile(
    join(directory, 'updates', 'transaction.json'),
    JSON.stringify({
      id: 'operation',
      managerPending: true,
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      events: [],
    }),
  );
  await publishMonitor(
    join(directory, 'maintenance'),
    JSON.parse(
      await readFile(join(directory, 'updates', 'transaction.json'), 'utf8'),
    ),
  );
  return { directory, docker, manager, plan, handle };
}
test('replaces only the reviewed Manager, preserves protections and cleans its stopped original after success', async (t) => {
  const f = await fixture(t);
  const result = await runManagerReplacement({
    ...f,
    id: f.handle.id,
    probe: async () => ({ healthy: true }),
  });
  assert.equal(result.stage, 'succeeded');
  const current = await f.docker.inspectContainer('mergeron-dev-manager');
  assert.deepEqual(current.HostConfig, f.plan.original.HostConfig);
  assert.deepEqual(current.Config.Env, ['SECRET=private']);
  await assert.rejects(() => f.docker.inspectContainer('old'), {
    statusCode: 404,
  });
  assert.equal(result.cleanupStatus, 'complete');
  assert(f.docker.calls.some((c) => c[0] === 'remove' && c[1] === 'old'));
  const state = await readFile(
    join(f.directory, 'maintenance', 'state.json'),
    'utf8',
  );
  assert.equal(JSON.parse(state).operation.status, 'succeeded');
  assert(!state.includes('SECRET'));
  assert(!state.includes('private'));
  const helper = f.docker.calls.find(
    (c) => c[0] === 'create' && c[1].includes('replacement'),
  );
  assert.equal(helper[2].HostConfig.NetworkMode, 'none');
  assert.equal(helper[2].HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(helper[2].HostConfig.CapDrop, ['ALL']);
});
test('restores the original Manager on a failed health check without deleting persistent data', async (t) => {
  const f = await fixture(t);
  f.docker.failNew = true;
  const result = await runManagerReplacement({
    ...f,
    id: f.handle.id,
    probe: async () => ({ healthy: false }),
  });
  assert.equal(result.stage, 'rolledBack');
  const old = await f.docker.inspectContainer('mergeron-dev-manager');
  assert.equal(old.Id, 'old');
  assert(old.State.Running);
  assert(!f.docker.calls.some((c) => c[0] === 'remove' && c[1] === 'old'));
  assert.equal(
    JSON.parse(
      await readFile(join(f.directory, 'maintenance', 'state.json'), 'utf8'),
    ).operation.status,
    'recoveryRequired',
  );
});
test('never stops or renames a Manager whose protected specification changed after review', async (t) => {
  const f = await fixture(t);
  f.docker.values.get('old').HostConfig.Privileged = true;
  const before = f.docker.calls.length;
  const result = await runManagerReplacement({ ...f, id: f.handle.id });
  assert.equal(result.stage, 'recoveryRequired');
  assert(
    !f.docker.calls
      .slice(before)
      .some((c) => ['stop', 'rename', 'remove'].includes(c[0])),
  );
});
test('rejects a stale plan and network-enabled Manager before launching a helper', async (t) => {
  const f = await fixture(t);
  f.docker.values.get('old').HostConfig.NetworkMode = 'host';
  await assert.rejects(() => f.manager.plan(target), /IdentityChanged/);
  await assert.rejects(
    () => f.manager.launch(f.plan, 'operation'),
    /IdentityChanged/,
  );
});
test('coordinator binds both component plans to one fingerprint and validates confirmation before launch', async () => {
  const launch = [];
  const base = {
    fingerprint: 'base',
    applicable: true,
    blockers: [],
    images: { application: 'pinned' },
    confirmation: 'UPDATE',
  };
  const updater = { plan: async () => base, begin: async (input) => input };
  const replacement = {
    plan: async () => ({ image: target, fingerprint: 'manager' }),
    launch: async (...args) => {
      launch.push(args);
      return {};
    },
    cancel: async () => {},
  };
  const c = new GlobalUpdateCoordinator({
    updater,
    replacement,
    docker: {},
    stack: 'mergeron-dev',
  });
  const images = { application: 'pinned', manager: target };
  const plan = await c.plan(images);
  await assert.rejects(
    () =>
      c.begin({
        images,
        expectedFingerprint: plan.fingerprint,
        confirmation: 'WRONG',
      }),
    /ConfirmationRequired/,
  );
  assert.equal(launch.length, 0);
  const result = await c.begin({
    images,
    expectedFingerprint: plan.fingerprint,
    confirmation: 'UPDATE',
  });
  assert.equal(result.managerPending, true);
  assert.match(result.requestedId, /^[a-f0-9-]{36}$/);
  assert.equal(result.expectedFingerprint, 'base');
  assert.deepEqual(result.images, base.images);
  assert.equal(launch.length, 0);
  await updater.prepareManager({
    id: result.requestedId,
    managerTarget: result.managerTarget,
    managerFingerprint: result.managerFingerprint,
  });
  assert.equal(launch.length, 1);
  await assert.rejects(
    () =>
      updater.prepareManager({
        id: result.requestedId,
        managerTarget: target,
        managerFingerprint: 'stale',
      }),
    /updatePlanChanged/,
  );
});

test('rejects an application-only rollback after a coordinated Manager replacement', async () => {
  const updater = new TransactionalUpdater({});
  updater.current = { managerPending: true, status: 'succeeded' };
  await assert.rejects(
    () =>
      updater.requestRollback({
        confirmation: 'ROLLBACK',
        operationId: 'operation',
      }),
    /updateCoordinatedRollbackRequired/,
  );
});

test('rejects an incompatible target Manager image before creating a replacement job', async (t) => {
  const f = await fixture(t);
  const inspect = f.docker.inspectImage.bind(f.docker);
  f.docker.inspectImage = (reference) =>
    reference === target
      ? Promise.resolve({ Id: nextImage, Config: { Labels: {} } })
      : inspect(reference);
  const before = f.docker.calls.length;
  await assert.rejects(
    () => f.manager.launch(f.plan, 'another-operation'),
    /updateManagerImageInvalid/,
  );
  assert(
    !f.docker.calls
      .slice(before)
      .some((call) => ['create', 'stop', 'rename', 'remove'].includes(call[0])),
  );
});

test('cleanup failure keeps success and retries safely without rolling back the healthy Manager', async (t) => {
  const f = await fixture(t);
  const remove = f.docker.removeContainer.bind(f.docker);
  let fail = true;
  f.docker.removeContainer = async (id) => {
    if (id === 'old' && fail) throw new Error('Docker unavailable');
    return remove(id);
  };
  const run = () =>
    runManagerReplacement({
      ...f,
      id: f.handle.id,
      probe: async () => ({ healthy: true }),
    });
  const first = await run();
  assert.equal(first.stage, 'succeeded');
  assert.equal(first.cleanupStatus, 'pending');
  assert.equal((await f.docker.inspectContainer('old')).State.Running, false);
  const active = (await f.docker.inspectContainer('mergeron-dev-manager')).Id;
  fail = false;
  assert.equal((await run()).cleanupStatus, 'complete');
  assert.equal(
    (await f.docker.inspectContainer('mergeron-dev-manager')).Id,
    active,
  );
  await run(); // Idempotent after deletion.
  assert.equal(
    f.docker.calls.filter((c) => c[0] === 'remove' && c[1] === 'old').length,
    1,
  );
});

for (const change of ['running', 'name', 'labels', 'specification', 'active']) {
  test(`successful cleanup refuses a changed ${change} identity and preserves success`, async (t) => {
    const f = await fixture(t);
    let probes = 0;
    const result = await runManagerReplacement({
      ...f,
      id: f.handle.id,
      probe: async () => {
        if (++probes === 2) {
          const old = f.docker.values.get('old');
          if (change === 'running') old.State.Running = true;
          if (change === 'name') old.Name = '/unrelated';
          if (change === 'labels')
            old.Config.Labels['io.mergeron.stack'] = 'production';
          if (change === 'specification') old.HostConfig.Privileged = true;
          if (change === 'active') return { healthy: false };
        }
        return { healthy: true };
      },
    });
    assert.equal(result.stage, 'succeeded');
    assert.equal(result.cleanupStatus, 'pending');
    assert(f.docker.values.has('old'));
    assert(!f.docker.calls.some((c) => c[0] === 'remove' && c[1] === 'old'));
  });
}

test('replacement resets the old generated hostname and never carries an explicit HOSTNAME into the new Manager', async (t) => {
  const f = await fixture(t);
  const old = f.docker.values.get('old');
  old.Config.Hostname = 'aaaaaaaaaaaa';
  old.Config.Env.push('HOSTNAME=aaaaaaaaaaaa');
  const plan = await f.manager.plan(target);
  assert.equal(plan.original.Hostname, '');
  assert.deepEqual(plan.original.Env, ['SECRET=private']);
  assert.deepEqual(plan.original.HostConfig, old.HostConfig);
  assert.deepEqual(plan.original.Labels, old.Config.Labels);
});
