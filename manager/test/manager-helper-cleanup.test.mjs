import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagerHelperCleanup } from '../src/manager-helper-cleanup.mjs';
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'helper-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'replacements'));
  await mkdir(join(directory, 'updates'));
  const host = {
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    Binds: ['/persistent:/state'],
  };
  const labels = {
    'io.mergeron.stack': 'mergeron-dev',
    'io.mergeron.component': 'managerReplacement',
    'io.mergeron.replacement': id,
  };
  const helper = {
    Id: 'helper',
    Name: '/mergeron-dev-manager-replacement-' + id,
    Image: 'old-image',
    Config: {
      Labels: labels,
      Entrypoint: ['/nodejs/bin/node', 'src/manager-replacement-worker.mjs'],
      Cmd: [id],
    },
    HostConfig: host,
    State: { Running: false, Restarting: false, ExitCode: 0 },
  };
  const active = {
    Id: 'active',
    Name: '/mergeron-dev-manager',
    Image: 'new-image',
    HostConfig: host,
    State: { Running: true, Health: { Status: 'healthy' } },
    Config: {
      Labels: {
        ...labels,
        'io.mergeron.component': 'manager',
        'io.mergeron.managed': 'true',
      },
    },
  };
  const job = {
    id,
    stack: 'mergeron-dev',
    operationId: 'operation',
    stage: 'succeeded',
    cleanupStatus: 'complete',
    candidateId: active.Id,
    targetImageId: active.Image,
    original: { Image: helper.Image, HostConfig: host },
  };
  const path = join(directory, 'replacements', id + '.json');
  const operationPath = join(directory, 'updates', 'transaction.json');
  const operation = { id: 'operation', status: 'succeeded' };
  await writeFile(path, JSON.stringify(job));
  await writeFile(operationPath, JSON.stringify(operation));
  let exists = true;
  const calls = [];
  const docker = {
    listContainers: async () =>
      exists ? [{ Id: helper.Id, Labels: labels }] : [],
    inspectContainer: async (name) =>
      structuredClone(name === helper.Id ? helper : active),
    containerLogs: async () => 'completed helper\n',
    removeContainer: async (value) => {
      calls.push(value);
      exists = false;
    },
  };
  let blocked = false;
  const cleanup = new ManagerHelperCleanup({
    docker,
    directory,
    stack: 'mergeron-dev',
    blocked: async () => blocked,
    probe: async () => ({ healthy: true }),
  });
  return {
    cleanup,
    helper,
    active,
    job,
    path,
    operationPath,
    operation,
    calls,
    directory,
    docker,
    block: () => {
      blocked = true;
    },
  };
}
test('archives bounded logs, removes only the stopped successful helper and is idempotent', async (t) => {
  const f = await fixture(t);
  await f.cleanup.tick();
  await f.cleanup.tick();
  assert.deepEqual(f.calls, ['helper']);
  assert.deepEqual(f.cleanup.status, { retained: 0, unavailable: false });
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(f.directory, 'replacements/helper-logs', id + '.json'),
        'utf8',
      ),
    ),
    { helperId: 'helper', replacementId: id, logs: 'completed helper\n' },
  );
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.job);
});
for (const [name, change] of [
  [
    'running helper',
    (f) => {
      f.helper.State.Running = true;
    },
  ],
  [
    'restarting helper',
    (f) => {
      f.helper.State.Restarting = true;
    },
  ],
  [
    'failed helper',
    (f) => {
      f.helper.State.ExitCode = 1;
    },
  ],
  [
    'another stack',
    (f) => {
      f.helper.Config.Labels['io.mergeron.stack'] = 'production';
    },
  ],
  [
    'renamed helper',
    (f) => {
      f.helper.Name = '/unrelated';
    },
  ],
  [
    'another image',
    (f) => {
      f.helper.Image = 'unknown';
    },
  ],
  [
    'another command',
    (f) => {
      f.helper.Config.Cmd = ['other'];
    },
  ],
  [
    'unhealthy Manager',
    (f) => {
      f.active.State.Health.Status = 'unhealthy';
    },
  ],
  [
    'changed mounts',
    (f) => {
      f.active.HostConfig = {
        ...f.active.HostConfig,
        Binds: ['/other:/state'],
      };
    },
  ],
  [
    'another Manager',
    (f) => {
      f.active.Id = 'other';
    },
  ],
  ['busy operation', (f) => f.block()],
  [
    'failed readiness',
    (f) => {
      f.cleanup.probe = async () => ({ healthy: false });
    },
  ],
  [
    'incomplete journal',
    (f) => {
      f.job.stage = 'waiting';
    },
  ],
  [
    'deferred original cleanup',
    (f) => {
      f.job.cleanupStatus = 'pending';
    },
  ],
  [
    'another operation',
    (f) => {
      f.operation.id = 'new';
    },
  ],
])
  test(`preserves ${name}`, async (t) => {
    const f = await fixture(t);
    change(f);
    await writeFile(f.path, JSON.stringify(f.job));
    await writeFile(f.operationPath, JSON.stringify(f.operation));
    await f.cleanup.tick();
    assert.deepEqual(f.calls, []);
  });
test('refuses symlinked journals', async (t) => {
  const f = await fixture(t);
  await rm(f.path);
  await symlink(f.operationPath, f.path);
  await f.cleanup.tick();
  assert.deepEqual(f.calls, []);
  assert.equal(f.cleanup.status.retained, 1);
});
test('log failures preserve the helper and a later successful pass recovers', async (t) => {
  const f = await fixture(t);
  f.docker.containerLogs = async () => {
    throw new Error('failure');
  };
  await f.cleanup.tick();
  assert.deepEqual(f.calls, []);
  assert.equal(f.cleanup.status.retained, 1);
  f.docker.containerLogs = async () => 'retried';
  await f.cleanup.tick();
  assert.deepEqual(f.calls, ['helper']);
});
test('refuses helper identity changes during log preservation', async (t) => {
  const f = await fixture(t);
  f.docker.containerLogs = async () => {
    f.helper.State.Running = true;
    return 'logs';
  };
  await f.cleanup.tick();
  assert.deepEqual(f.calls, []);
});
test('does not remove after an operation change during log preservation', async (t) => {
  const f = await fixture(t);
  f.docker.containerLogs = async () => {
    await writeFile(
      f.operationPath,
      JSON.stringify({ id: 'next', status: 'running' }),
    );
    return 'logs';
  };
  await f.cleanup.tick();
  assert.deepEqual(f.calls, []);
});
test('serializes concurrent ticks and reports Docker errors without rejecting the timer', async (t) => {
  const f = await fixture(t);
  f.docker.listContainers = async () => {
    throw new Error('docker down');
  };
  const a = f.cleanup.tick();
  assert.equal(f.cleanup.tick(), a);
  await a;
  assert.equal(f.cleanup.status.unavailable, true);
  assert.deepEqual(f.calls, []);
});
