import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  symlink,
  truncate,
  link,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionalUpdater } from '../src/updater.mjs';
import { scopeManifest } from '../src/inventory.mjs';

const manifest = scopeManifest(
  JSON.parse(
    await readFile(new URL('../stack-manifest.json', import.meta.url)),
  ),
  'mergeron-dev',
  'development',
);
const images = { application: 'ghcr.io/maxhugit/mergeron:next' };

class Docker {
  constructor(root) {
    this.values = new Map();
    this.calls = [];
    this.sequence = 0;
    for (const component of manifest.components) {
      const repo = component.allowedImageRepositories[0];
      const config = {
        Image: `${repo}:previous`,
        Labels: {
          'io.mergeron.managed': 'true',
          'io.mergeron.stack': manifest.stack,
          'io.mergeron.component': component.id,
        },
        Env: ['SECRET=never-display'],
        Healthcheck: { Test: ['CMD', 'true'] },
      };
      const binds =
        component.id === 'application'
          ? [`${root}/home:/home/codex`, `${root}/workspace:/workspaces`]
          : [];
      const spec = {
        ...config,
        HostConfig: { Binds: binds },
        NetworkingConfig: {
          EndpointsConfig: Object.fromEntries(
            component.requiredNetworks.map((n) => [
              n,
              { Aliases: [component.canonicalName] },
            ]),
          ),
        },
      };
      const id = `original-${component.id}`;
      this.values.set(
        id,
        this.inspect(id, component.canonicalName, spec, true),
      );
    }
  }
  image(reference) {
    const repo = reference.split('@')[0].replace(/:[^/:]+$/, '');
    return `${repo}@sha256:${(reference.includes('next') ? 'b' : 'a').repeat(64)}`;
  }
  inspect(id, name, spec, running = false) {
    const { HostConfig, NetworkingConfig, ...Config } = structuredClone(spec);
    return {
      Id: id,
      Name: `/${name}`,
      Config,
      HostConfig,
      Image: this.image(Config.Image),
      State: {
        Running: running,
        Status: running ? 'running' : 'created',
        Health: { Status: 'healthy' },
      },
      Mounts: (HostConfig.Binds ?? []).map((b) => {
        const [Source, Destination] = b.split(':');
        return { Type: 'bind', Source, Destination, RW: true };
      }),
      NetworkSettings: { Networks: NetworkingConfig.EndpointsConfig },
    };
  }
  async listContainers() {
    return [...this.values.values()].map((v) => ({
      Id: v.Id,
      Names: [v.Name],
      Image: v.Config.Image,
      Labels: v.Config.Labels,
    }));
  }
  async inspectContainer(id) {
    return structuredClone(this.values.get(id));
  }
  async inspectImage(ref) {
    const pinned = this.image(ref);
    return { Id: pinned, RepoDigests: [pinned] };
  }
  async pullImage(ref) {
    this.calls.push(['pull', ref]);
    if (this.pullFailure) throw new Error('registry password=secret');
  }
  async stopContainer(id) {
    this.calls.push(['stop', id]);
    this.values.get(id).State.Running = false;
  }
  async startContainer(id) {
    this.calls.push(['start', id]);
    const value = this.values.get(id);
    value.State.Running = true;
    if (
      this.unhealthy &&
      value.Config.Labels['io.mergeron.transaction'] &&
      value.Config.Labels['io.mergeron.component'] === 'application'
    ) {
      await writeFile(join(this.root, 'home', 'database'), 'migrated');
      await writeFile(join(this.root, 'home', 'new-file'), 'new data');
      value.State.Health.Status = 'unhealthy';
    }
    if (this.afterStart) await this.afterStart(id);
  }
  async renameContainer(id, name) {
    this.calls.push(['rename', id, name]);
    this.values.get(id).Name = `/${name}`;
  }
  async createContainer(name, spec) {
    const id = `candidate-${++this.sequence}`;
    this.calls.push(['create', name]);
    this.values.set(id, this.inspect(id, name, spec));
    if (this.afterCreate) await this.afterCreate(id);
    return { Id: id };
  }
  async removeContainer(id) {
    assert.equal(this.values.get(id).State.Running, false);
    this.calls.push(['remove', id]);
    this.values.delete(id);
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'manager-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['home', 'workspace', 'logs', 'ssh', 'config'])
    await mkdir(join(root, name), { mode: 0o700 });
  for (const name of [
    'backend-token.txt',
    'backend-token-nginx.txt',
    'openai-api-key.txt',
  ])
    await writeFile(join(root, name), 'secret', { mode: 0o600 });
  await writeFile(join(root, 'home', 'database'), 'original', { mode: 0o600 });
  await symlink('/does/not/exist', join(root, 'home', 'external-link'));
  const docker = new Docker(root);
  docker.root = root;
  const options = {
    manifest,
    docker,
    configuration: { stateRoot: root, hostStatePath: root },
    adoptionPath: join(root, 'manager-state', 'adoption.json'),
    directory: join(root, 'manager-state', 'updates'),
    healthTimeoutMs: 10,
    pollMs: 1,
  };
  const updater = new TransactionalUpdater(options);
  return { root, docker, updater, options };
}
async function begin(updater) {
  const plan = await updater.plan(images);
  assert.deepEqual(plan.blockers, []);
  await updater.begin({
    images,
    confirmation: 'UPDATE_WITH_ROLLBACK',
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
}

test('DEV visual image migrates only target seccomp and restores the exact old profile on rollback', async (t) => {
  const { updater, docker } = await fixture(t);
  const oldProfile = JSON.parse(
    await readFile(
      new URL('../../deployment/config/seccomp-bwrap.json', import.meta.url),
      'utf8',
    ),
  );
  oldProfile.syscalls = oldProfile.syscalls.filter(
    (rule) => !(rule.names.includes('chroot') && !rule.includes),
  );
  const application = docker.values.get('original-application');
  Object.assign(application.HostConfig, {
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: [
      'no-new-privileges:true',
      `seccomp=${JSON.stringify(oldProfile)}`,
    ],
  });
  const originalHost = structuredClone(application.HostConfig);
  const inspect = docker.inspectImage.bind(docker);
  docker.inspectImage = async (ref) => ({
    ...(await inspect(ref)),
    Config: {
      Labels: ref.includes('next')
        ? { 'io.mergeron.agent-visual-testing': '1' }
        : {},
    },
  });
  await begin(updater);
  assert.equal(updater.current.status, 'succeeded');
  const item = updater.current.containers.find(
    (item) => item.component === 'application',
  );
  assert.deepEqual(item.original.HostConfig, originalHost);
  const target = docker.values.get(item.candidateId).HostConfig;
  assert.deepEqual(
    { ...target, SecurityOpt: originalHost.SecurityOpt },
    originalHost,
  );
  assert.deepEqual(
    JSON.parse(target.SecurityOpt[1].slice(8)).syscalls.at(-1).names,
    ['chroot'],
  );
  await updater.requestRollback({
    operationId: updater.current.id,
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
  });
  await updater.task;
  assert.equal(updater.current.status, 'rolledBack');
  const restored = [...docker.values.values()].find(
    (item) => item.Name === '/mergeron-dev-ui',
  );
  assert.deepEqual(restored.HostConfig, originalHost);
});

for (const selected of ['ingress', 'egress']) {
  test(`individual ${selected} update changes only its image and keeps a complete rollback`, async (t) => {
    const { updater, docker } = await fixture(t);
    const before = Object.fromEntries(
      [...docker.values.values()].map((c) => [
        c.Config.Labels['io.mergeron.component'],
        docker.image(c.Config.Image),
      ]),
    );
    const component = manifest.components.find((c) => c.id === selected);
    const target = `${component.allowedImageRepositories[0]}:next`;
    const selection = { [selected]: target };
    const plan = await updater.plan(selection);
    assert.deepEqual(plan.blockers, []);
    await updater.begin({
      images: selection,
      confirmation: 'UPDATE_WITH_ROLLBACK',
      expectedFingerprint: plan.fingerprint,
    });
    await updater.task;
    assert.equal(updater.current.status, 'succeeded');
    for (const component of manifest.components) {
      const active = [...docker.values.values()].find(
        (c) => c.Name === `/${component.canonicalName}`,
      );
      assert.equal(
        active.Config.Image,
        component.id === selected ? docker.image(target) : before[component.id],
      );
    }
    assert.deepEqual(
      docker.calls
        .filter(([action]) => action === 'pull')
        .map(([, ref]) => ref),
      [target],
    );
    await updater.requestRollback({
      operationId: updater.current.id,
      confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
    });
    await updater.task;
    assert.equal(updater.current.status, 'rolledBack');
  });
}

for (const local of [false, true])
  test(`managed DEV browser participates in update and rollback with persistent public DNS (local image: ${local})`, async (t) => {
    const { updater, docker } = await fixture(t);
    const localId = 'sha256:' + 'c'.repeat(64);
    const localTag = 'mergeron-dev-browser:existing';
    if (local) {
      const image = docker.image.bind(docker);
      const inspectImage = docker.inspectImage.bind(docker);
      docker.image = (reference) =>
        [localTag, localId].includes(reference) ? localId : image(reference);
      docker.inspectImage = async (reference) =>
        [localTag, localId].includes(reference)
          ? { Id: localId, RepoTags: [localTag], RepoDigests: [] }
          : inspectImage(reference);
    }
    const browser = {
      id: 'browser',
      displayName: 'Mergeron Browser',
      canonicalName: 'mergeron-dev-browser',
      stackName: 'mergeron-dev',
      legacyNames: [],
      allowedImageRepositories: [
        'ghcr.io/maxhugit/mergeron-browser',
        'mergeron-dev-browser',
      ],
      requiredNetworks: [
        'mergeron-dev-browser-control',
        'mergeron-dev-browser-egress',
      ],
      protectedMounts: [],
      dns: ['1.1.1.1'],
    };
    updater.manifest = {
      ...manifest,
      components: [...manifest.components, browser],
    };
    docker.values.set(
      'original-browser',
      docker.inspect(
        'original-browser',
        browser.canonicalName,
        {
          Image: local
            ? localTag
            : 'ghcr.io/maxhugit/mergeron-browser:previous',
          User: 'pwuser',
          Env: ['BROWSER_WS_PATH=' + 'x'.repeat(32)],
          Labels: {
            'io.mergeron.managed': 'true',
            'io.mergeron.component': 'browser',
            'io.mergeron.stack': 'mergeron-dev',
          },
          Healthcheck: { Test: ['CMD', 'true'] },
          HostConfig: {
            Dns: [],
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true', 'seccomp=reviewed-profile'],
          },
          NetworkingConfig: {
            EndpointsConfig: Object.fromEntries(
              browser.requiredNetworks.map((name) => [
                name,
                { Aliases: [browser.canonicalName] },
              ]),
            ),
          },
        },
        true,
      ),
    );
    await begin(updater);
    assert.equal(updater.current.status, 'succeeded');
    const active = () =>
      [...docker.values.values()].find(
        (c) => c.Name === '/mergeron-dev-browser',
      );
    assert.deepEqual(active().HostConfig.Dns, ['1.1.1.1']);
    assert.deepEqual(active().Config.Env, [
      'BROWSER_WS_PATH=' + 'x'.repeat(32),
    ]);
    const application = [...docker.values.values()].find(
      (c) => c.Name === '/mergeron-dev-ui',
    );
    assert.ok(
      application.Config.Env.includes(
        'MERGERON_BROWSER_ENDPOINT=ws://mergeron-dev-browser:3000/' +
          'x'.repeat(32),
      ),
    );
    assert.ok(
      application.NetworkSettings.Networks['mergeron-dev-browser-control'],
    );
    assert.ok(!JSON.stringify(updater.status()).includes('x'.repeat(32)));
    assert.ok(
      docker.calls.some(
        ([action, id]) => action === 'stop' && id === 'original-browser',
      ),
    );
    await updater.rollback();
    assert.deepEqual(active().HostConfig.Dns, ['1.1.1.1']);
    assert.deepEqual(active().Config.Env, [
      'BROWSER_WS_PATH=' + 'x'.repeat(32),
    ]);
  });

test('fast mode is rejected for production, unknown environments and production stack names', async (t) => {
  const { updater } = await fixture(t);
  const original = updater.manifest;
  for (const change of [
    { environment: 'production' },
    { environment: undefined },
    { stack: 'mergeron' },
  ]) {
    updater.manifest = { ...original, ...change };
    await assert.rejects(
      updater.plan(images, 'dev-fast'),
      /updateFastDevelopmentOnly/,
    );
    assert.equal(updater.busy, false);
  }
  updater.manifest = original;
  await assert.rejects(updater.plan(images, 'unknown'), /updateInvalidMode/);
});

test('fast dev update preserves a complete backup and full data rollback', async (t) => {
  const { root, updater } = await fixture(t);
  for (let n = 0; n < 24; n++)
    await writeFile(join(root, 'workspace', `file-${n}`), `original-${n}`, {
      mode: 0o640,
    });
  const plan = await updater.plan(images, 'dev-fast');
  const standard = await updater.plan(images);
  assert.notEqual(plan.fingerprint, standard.fingerprint);
  await assert.rejects(
    updater.begin({
      images,
      mode: 'standard',
      confirmation: 'UPDATE_WITH_ROLLBACK',
      expectedFingerprint: plan.fingerprint,
    }),
    /updatePlanChanged/,
  );
  await updater.begin({
    images,
    mode: 'dev-fast',
    confirmation: 'UPDATE_WITH_ROLLBACK',
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  assert.equal(updater.current.status, 'succeeded');
  assert.equal(updater.current.backupComplete, true);
  for (let n = 0; n < 24; n++)
    assert.equal(
      await readFile(
        join(
          updater.directory,
          updater.current.id,
          'backup',
          'workspace',
          `file-${n}`,
        ),
        'utf8',
      ),
      `original-${n}`,
    );
  await writeFile(join(root, 'home', 'database'), 'modified-after-update');
  await updater.requestRollback({
    operationId: updater.current.id,
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
  });
  await updater.task;
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(
    await readFile(join(root, 'home', 'database'), 'utf8'),
    'original',
  );
});

test('fast mode reuses only a verified local immutable image, never a mutable tag', async (t) => {
  const { updater, docker } = await fixture(t);
  const immutable = {
    application: `ghcr.io/maxhugit/mergeron@sha256:${'b'.repeat(64)}`,
  };
  const inspect = docker.inspectImage.bind(docker);
  docker.inspectImage = async (reference) =>
    reference === immutable.application
      ? { Id: reference, RepoDigests: [reference] }
      : inspect(reference);
  const plan = await updater.plan(immutable, 'dev-fast');
  await updater.begin({
    images: immutable,
    mode: 'dev-fast',
    confirmation: 'UPDATE_WITH_ROLLBACK',
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  assert.equal(updater.current.status, 'succeeded');
  assert.equal(docker.calls.filter(([action]) => action === 'pull').length, 0);
});

test('fast mode still pulls mutable tags and missing immutable images', async (t) => {
  for (const mutable of [true, false]) {
    const { updater, docker } = await fixture(t);
    const requested = mutable
      ? images
      : { application: `ghcr.io/maxhugit/mergeron@sha256:${'b'.repeat(64)}` };
    const inspect = docker.inspectImage.bind(docker);
    let pulled = false;
    const pull = docker.pullImage.bind(docker);
    docker.pullImage = async (reference) => {
      await pull(reference);
      pulled = true;
    };
    docker.inspectImage = async (reference) => {
      if (!mutable && reference === requested.application) {
        if (!pulled) throw new Error('not found');
        return { Id: reference, RepoDigests: [reference] };
      }
      return inspect(reference);
    };
    const plan = await updater.plan(requested, 'dev-fast');
    await updater.begin({
      images: requested,
      mode: 'dev-fast',
      confirmation: 'UPDATE_WITH_ROLLBACK',
      expectedFingerprint: plan.fingerprint,
    });
    await updater.task;
    assert.equal(updater.current.status, 'succeeded');
    assert.equal(
      docker.calls.filter(([action]) => action === 'pull').length,
      1,
    );
  }
});

test('retains ten backups by default and persists a validated stack-scoped limit', async (t) => {
  const { updater, options } = await fixture(t);
  assert.deepEqual(await updater.backupRetention(), { maxBackups: 10 });
  for (const maxBackups of [0, -1, 1.5, 1001, '10', null])
    await assert.rejects(updater.setBackupRetention({ maxBackups }), /Invalid/);
  await updater.setBackupRetention({ maxBackups: 2 });
  assert.deepEqual(await new TransactionalUpdater(options).backupRetention(), {
    maxBackups: 2,
  });
  updater.busy = true;
  await assert.rejects(
    updater.setBackupRetention({ maxBackups: 3 }),
    /InProgress/,
  );
  updater.busy = false;
  await writeFile(
    join(options.directory, '..', 'backup-retention.json'),
    JSON.stringify({
      stack: 'another',
      environment: 'development',
      maxBackups: 1,
    }),
  );
  await assert.rejects(updater.backupRetention(), /Invalid/);
});

test('applies retention only after successful updates and preserves current rollback and journals', async (t) => {
  const { updater, options, root } = await fixture(t);
  await begin(updater);
  const oldest = updater.current.id;
  const quarantine = join(options.directory, oldest, 'quarantine');
  await mkdir(quarantine);
  await writeFile(join(quarantine, 'sentinel'), 'keep');
  await begin(updater);
  const second = updater.current.id;
  await updater.setBackupRetention({ maxBackups: 1 });
  assert.equal(
    (await updater.listBackups()).backups.length,
    2,
    'Saving must not delete immediately',
  );
  const unknown = join(
    options.directory,
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'backup',
  );
  await mkdir(unknown, { recursive: true });
  await begin(updater);
  const backups = (await updater.listBackups()).backups;
  assert.deepEqual(
    backups.filter((b) => b.status !== 'unknown').map((b) => b.id),
    [updater.current.id],
  );
  assert.equal(backups.find((b) => b.current).restorable, true);
  assert.ok((await lstat(unknown)).isDirectory());
  assert.equal(await readFile(join(quarantine, 'sentinel'), 'utf8'), 'keep');
  for (const id of [oldest, second]) {
    assert.equal(
      JSON.parse(await readFile(join(options.directory, id + '.json'), 'utf8'))
        .backupComplete,
      false,
    );
    await assert.rejects(lstat(join(options.directory, id, 'backup')), {
      code: 'ENOENT',
    });
  }
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
});

test('invalid retention never rolls back an otherwise successful update or deletes backups', async (t) => {
  const { updater, options } = await fixture(t);
  await begin(updater);
  await writeFile(
    join(options.directory, '..', 'backup-retention.json'),
    'invalid',
  );
  await begin(updater);
  assert.equal(updater.current.status, 'succeeded');
  assert.equal((await updater.listBackups()).backups.length, 2);
});

test('lists dated backups without transaction secrets and deletes only the selected copy', async (t) => {
  const { root, updater, options } = await fixture(t);
  await begin(updater);
  const first = updater.current.id;
  await begin(updater);
  const second = updater.current.id;
  await updater.listBackups();
  await updater.backupSizeTask;
  const list = await updater.listBackups();
  assert.equal(list.backups.length, 2);
  assert.equal(
    list.backups[0].path,
    join(options.directory, list.backups[0].id, 'backup'),
  );
  assert.ok(
    list.backups.every(
      (backup) => Number.isFinite(backup.sizeBytes) && backup.sizeBytes >= 0,
    ),
  );
  assert.equal(
    list.totalSizeBytes,
    list.backups.reduce((sum, backup) => sum + backup.sizeBytes, 0),
  );
  assert.equal(
    list.backups.every(
      (backup) =>
        backup.canDelete && !Number.isNaN(Date.parse(backup.createdAt)),
    ),
    true,
  );
  assert.equal(JSON.stringify(list).includes('SECRET'), false);
  assert.equal(JSON.stringify(list).includes('never-display'), false);
  await updater.deleteBackup({
    operationId: first,
    confirmation: 'DELETE_UPDATE_BACKUP',
  });
  assert.equal((await updater.listBackups()).backups.length, 1);
  assert.equal((await updater.listBackups()).backups[0].id, second);
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
  assert.equal(
    (await lstat(join(options.directory, `${first}.json`))).isFile(),
    true,
  );
  assert.equal(
    (await lstat(join(options.directory, second, 'backup'))).isDirectory(),
    true,
  );
});

test('deletes read-only backup directories without following links or changing live hardlinked files', async (t) => {
  const { root, updater, options } = await fixture(t);
  await begin(updater);
  const id = updater.current.id;
  const backup = join(options.directory, id, 'backup');
  await link(join(root, 'home/database'), join(backup, 'home/live-hardlink'));
  await symlink(join(root, 'home'), join(backup, 'home/live-directory'));
  const original = await lstat(join(root, 'home/database'));
  await chmod(join(backup, 'home'), 0o500);
  await chmod(backup, 0o500);
  await updater.deleteBackup({
    operationId: id,
    confirmation: 'DELETE_UPDATE_BACKUP',
  });
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
  const live = await lstat(join(root, 'home/database'));
  assert.equal(live.uid, original.uid);
  assert.equal(live.gid, original.gid);
  assert.equal(live.mode, original.mode);
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
  const journal = JSON.parse(
    await readFile(join(options.directory, 'transaction.json'), 'utf8'),
  );
  assert.equal(journal.backupComplete, false);
  assert.ok(journal.backupDeletedAt);
});

test('measures allocated backup blocks without following links or counting hardlinks twice', async (t) => {
  const { root, updater, options } = await fixture(t);
  await begin(updater);
  const directory = join(options.directory, updater.current.id, 'backup');
  const sparse = join(directory, 'sparse');
  await writeFile(sparse, '');
  await truncate(sparse, 32 * 1024 * 1024);
  const outside = join(root, 'outside');
  await writeFile(outside, Buffer.alloc(2 * 1024 * 1024));
  await symlink(outside, join(directory, 'external'));
  await writeFile(join(directory, 'one'), Buffer.alloc(1024 * 1024));
  await link(join(directory, 'one'), join(directory, 'two'));
  await updater.listBackups();
  await updater.backupSizeTask;
  const result = await updater.listBackups();
  assert.ok(result.totalSizeBytes >= 1024 * 1024);
  assert.ok(result.totalSizeBytes < 2 * 1024 * 1024);
});

test('does not invent a server path when the host mount cannot be verified', async (t) => {
  const { updater } = await fixture(t);
  await begin(updater);
  updater.configuration.hostStatePath = '/unavailable-host-state';
  const result = await updater.listBackups();
  assert.equal(result.backups[0].path, null);
  assert.ok(result.backups[0].managerPath.endsWith('/backup'));
});

test('finishes slow size scans in background without blocking or restarting on repeated lists', async (t) => {
  const { updater } = await fixture(t);
  await begin(updater);
  let finish;
  let calls = 0;
  updater.measureBackupSize = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = await updater.listBackups();
  assert.equal(first.sizesCalculating, true);
  assert.equal(first.backups[0].sizeStatus, 'calculating');
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await updater.listBackups();
  assert.equal(calls, 1);
  finish(12345);
  await updater.backupSizeTask;
  const result = await updater.listBackups();
  assert.equal(result.sizesCalculating, false);
  assert.equal(result.totalSizeBytes, 12345);
  assert.equal(result.backups[0].sizeStatus, 'ready');
  assert.equal(calls, 1);
});

test('a failed size scan does not starve the following backups', async (t) => {
  const { updater } = await fixture(t);
  await begin(updater);
  await begin(updater);
  let calls = 0;
  updater.measureBackupSize = async () => {
    if (++calls === 1) throw new Error('read denied');
    return 512;
  };
  await updater.listBackups();
  await updater.backupSizeTask;
  const result = await updater.listBackups();
  assert.equal(calls, 2);
  assert.equal(
    result.backups.filter((backup) => backup.sizeStatus === 'ready').length,
    1,
  );
  assert.equal(
    result.backups.filter((backup) => backup.sizeStatus === 'unavailable')
      .length,
    1,
  );
  assert.equal(result.totalSizeBytes, null);
});

test('deleting the latest backup preserves quarantine and disables rollback durably', async (t) => {
  const { updater, options } = await fixture(t);
  await begin(updater);
  const id = updater.current.id;
  await mkdir(join(options.directory, id, 'quarantine'));
  await writeFile(
    join(options.directory, id, 'quarantine', 'preserve'),
    'new data',
  );
  await updater.deleteBackup({
    operationId: id,
    confirmation: 'DELETE_UPDATE_BACKUP',
  });
  assert.equal(updater.status().operation.backupRetained, false);
  assert.equal(
    await readFile(
      join(options.directory, id, 'quarantine', 'preserve'),
      'utf8',
    ),
    'new data',
  );
  assert.equal(
    JSON.parse(
      await readFile(join(options.directory, 'transaction.json'), 'utf8'),
    ).backupComplete,
    false,
  );
  await assert.rejects(
    updater.requestRollback({
      operationId: id,
      confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
    }),
    /updateRollbackUnavailable/,
  );
  await updater.deleteBackup({
    operationId: id,
    confirmation: 'DELETE_UPDATE_BACKUP',
  });
});

test('refuses unconfirmed, unsafe, busy and recovery backup deletion', async (t) => {
  const { updater } = await fixture(t);
  await begin(updater);
  const id = updater.current.id;
  await assert.rejects(
    updater.deleteBackup({ operationId: id, confirmation: 'no' }),
    /ConfirmationRequired/,
  );
  await assert.rejects(
    updater.deleteBackup({
      operationId: '../home',
      confirmation: 'DELETE_UPDATE_BACKUP',
    }),
    /Invalid/,
  );
  updater.busy = true;
  await assert.rejects(
    updater.deleteBackup({
      operationId: id,
      confirmation: 'DELETE_UPDATE_BACKUP',
    }),
    /InProgress/,
  );
  assert.equal((await updater.listBackups()).backups[0].canDelete, false);
  updater.busy = false;
  updater.current.status = 'recoveryRequired';
  await assert.rejects(
    updater.deleteBackup({
      operationId: id,
      confirmation: 'DELETE_UPDATE_BACKUP',
    }),
    /InProgress/,
  );
});

test('does not follow a backup-directory symlink or delete unknown backup metadata', async (t) => {
  const { root, updater, options } = await fixture(t);
  await begin(updater);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await mkdir(join(options.directory, id));
  await symlink(join(root, 'home'), join(options.directory, id, 'backup'));
  await writeFile(
    join(options.directory, `${id}.json`),
    JSON.stringify({ ...updater.current, id }),
  );
  await assert.rejects(
    updater.deleteBackup({
      operationId: id,
      confirmation: 'DELETE_UPDATE_BACKUP',
    }),
    /Invalid/,
  );
  assert.equal(
    (await updater.listBackups()).backups.some((backup) => backup.id === id),
    false,
  );
  await rm(join(options.directory, id, 'backup'));
  await mkdir(join(options.directory, id, 'backup'));
  await rm(join(options.directory, `${id}.json`));
  assert.equal(
    (await updater.listBackups()).backups.find((backup) => backup.id === id)
      .canDelete,
    false,
  );
  await assert.rejects(
    updater.deleteBackup({
      operationId: id,
      confirmation: 'DELETE_UPDATE_BACKUP',
    }),
    /Invalid/,
  );
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
});

test('commits only healthy candidates, pins images, preserves mounts and hides secrets', async (t) => {
  const { root, updater, docker } = await fixture(t);
  await begin(updater);
  assert.equal(updater.current.status, 'succeeded');
  assert.equal(docker.values.size, 3);
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
  assert.equal((await lstat(join(root, 'home/database'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(updater.status()).includes('SECRET'), false);
  assert.ok(
    updater.current.containers.every((c) =>
      c.target.Image.includes('@sha256:'),
    ),
  );
  assert.equal((await updater.plan(images)).applicable, true);
});

test('failed health restores original database, quarantines newly written data and retains backup', async (t) => {
  const { root, updater, docker } = await fixture(t);
  docker.unhealthy = true;
  await begin(updater);
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
  const quarantine = join(
    updater.directory,
    updater.current.id,
    'quarantine',
    'home',
  );
  assert.equal(
    await readFile(join(quarantine, 'database'), 'utf8'),
    'migrated',
  );
  assert.equal(
    await readFile(join(quarantine, 'new-file'), 'utf8'),
    'new data',
  );
  assert.ok(
    [...docker.values.keys()].every((id) => id.startsWith('original-')),
  );
});

test('image pull failure never stops the stack and diagnostics do not leak credentials', async (t) => {
  const { updater, docker } = await fixture(t);
  docker.pullFailure = true;
  await begin(updater);
  assert.equal(updater.current.status, 'rolledBack');
  assert.deepEqual(
    docker.calls.map((c) => c[0]),
    ['pull'],
  );
  assert.equal(JSON.stringify(updater.status()).includes('password'), false);
});

test('image metadata failure during partial preparation leaves all services running and permits retry', async (t) => {
  const { updater, docker } = await fixture(t);
  const inspectImage = docker.inspectImage.bind(docker);
  docker.inspectImage = async (reference) => {
    if (reference.startsWith('nginx'))
      throw new Error('transient image metadata failure');
    return inspectImage(reference);
  };
  await begin(updater);
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(
    docker.calls.some(([action]) => action === 'stop'),
    false,
  );
  assert.ok([...docker.values.values()].every((value) => value.State.Running));
  docker.inspectImage = inspectImage;
  await begin(updater);
  assert.equal(updater.current.status, 'succeeded');
});

test('requires confirmation, a fresh plan and rejects arbitrary image repositories', async (t) => {
  const { updater, docker } = await fixture(t);
  await assert.rejects(
    updater.plan({ application: 'evil.example/image:latest' }),
    /updateImageNotAllowed/,
  );
  await assert.rejects(updater.begin({ images }), /updateConfirmationRequired/);
  await assert.rejects(
    updater.begin({
      images,
      confirmation: 'UPDATE_WITH_ROLLBACK',
      expectedFingerprint: 'stale',
    }),
    /updatePlanChanged/,
  );
  assert.deepEqual(docker.calls, []);
});

test('serializes concurrent requests during image download', async (t) => {
  const { updater, docker } = await fixture(t);
  let release;
  docker.pullImage = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const plan = await updater.plan(images);
  const input = {
    images,
    confirmation: 'UPDATE_WITH_ROLLBACK',
    expectedFingerprint: plan.fingerprint,
  };
  await updater.begin(input);
  await assert.rejects(updater.begin(input), /managerOperationInProgress/);
  release();
  await updater.task;
  assert.equal(updater.current.status, 'succeeded');
});

test('manual rollback recreates original pinned images after a successful commit', async (t) => {
  const { updater, root } = await fixture(t);
  await begin(updater);
  await writeFile(join(root, 'home/database'), 'after successful update');
  await updater.requestRollback({
    operationId: updater.current.id,
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
  });
  await updater.task;
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
});

test('restart recovers a crash after Docker creates a candidate before its ID is journalled', async (t) => {
  const { updater, docker, options, root } = await fixture(t);
  let crashed = false;
  docker.afterCreate = async () => {
    if (!crashed) {
      crashed = true;
      throw new Error('crash');
    }
  };
  // Simulate abrupt death: no in-process rollback, then instantiate a new Manager.
  updater.rollback = async () => {
    throw new Error('process terminated');
  };
  await begin(updater);
  const recovered = new TransactionalUpdater(options);
  await recovered.recover();
  assert.equal(recovered.current.status, 'rolledBack');
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
  assert.equal(docker.values.size, 3);
});

test('blocks unhealthy or unmanaged containers and unexpected persistent sources', async (t) => {
  const { updater, docker } = await fixture(t);
  const app = docker.values.get('original-application');
  app.Mounts[0].Source = '/production/home';
  app.Config.Labels['io.mergeron.managed'] = 'false';
  assert.equal((await updater.plan(images)).applicable, false);
  assert.deepEqual(docker.calls, []);
});

test('Docker mount and object key order does not invalidate an unchanged plan', async (t) => {
  const { updater, docker } = await fixture(t);
  const first = await updater.plan(images);
  for (const value of docker.values.values()) {
    value.Mounts.reverse();
    value.Config.Labels = Object.fromEntries(
      Object.entries(value.Config.Labels).reverse(),
    );
  }
  assert.equal((await updater.plan(images)).fingerprint, first.fingerprint);
});

test('blocks additional writable state mounts that are not covered by the backup', async (t) => {
  const { updater, docker, root } = await fixture(t);
  docker.values.get('original-application').Mounts.push({
    Type: 'bind',
    Source: `${root}/uncovered-data`,
    Destination: '/custom',
    RW: true,
  });
  const plan = await updater.plan(images);
  assert.equal(plan.applicable, false);
  assert.ok(plan.blockers.includes('application:updateMountOutsideState'));
});

test('quarantine references resolve when manager-state has another mount alias', async (t) => {
  const { root, options, docker } = await fixture(t);
  await mkdir(join(root, 'manager-state'));
  await mkdir(join(root, 'different-depth'));
  await symlink(
    join(root, 'manager-state'),
    join(root, 'different-depth/alias'),
  );
  const updater = new TransactionalUpdater({
    ...options,
    directory: join(root, 'different-depth/alias/updates'),
  });
  docker.unhealthy = true;
  await begin(updater);
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(
    await readFile(
      join(
        root,
        'manager-state/updates',
        updater.current.id,
        'quarantine/home/database',
      ),
      'utf8',
    ),
    'migrated',
  );
});

test('a failed backup restarts all original services without changing their data', async (t) => {
  const { updater, docker, root } = await fixture(t);
  const stop = docker.stopContainer.bind(docker);
  let injected = false;
  docker.stopContainer = async (id) => {
    await stop(id);
    if (!injected) {
      injected = true;
      // An unsupported special file is created only after preflight.
      await import('node:child_process').then(({ execFileSync }) =>
        execFileSync('mkfifo', [join(root, 'home/unsupported-fifo')]),
      );
    }
  };
  await begin(updater);
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(updater.current.backupComplete, false);
  assert.ok([...docker.values.values()].every((value) => value.State.Running));
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
});

test('rollback refuses a renamed candidate rather than replacing an unrelated resource', async (t) => {
  const { updater, docker } = await fixture(t);
  await begin(updater);
  const candidate = updater.current.containers[0];
  docker.values.get(candidate.candidateId).Name = '/manually-renamed';
  await assert.rejects(
    updater.requestRollback({
      operationId: updater.current.id,
      confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
    }),
    /updateCandidateIdentityConflict/,
  );
  assert.equal(updater.current.status, 'succeeded');
  assert.equal(updater.busy, false);
});
