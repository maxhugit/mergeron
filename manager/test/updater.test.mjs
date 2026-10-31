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
  chown,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionalUpdater, copyPersistentTree } from '../src/updater.mjs';
import {
  extractBackupArchive,
  BACKUP_ARCHIVE_NAME,
} from '../src/backup-archive.mjs';
import { scopeManifest } from '../src/inventory.mjs';
import {
  recordedBackupPolicy,
  backupEntries,
  rollbackConfirmation,
} from '../src/backup-policy.mjs';

const manifest = scopeManifest(
  JSON.parse(
    await readFile(new URL('../stack-manifest.json', import.meta.url)),
  ),
  'mergeron',
  'production',
);
const images = { application: 'ghcr.io/maxhugit/mergeron:next' };

class Docker {
  constructor(root, scopedManifest = manifest) {
    this.values = new Map();
    this.calls = [];
    this.sequence = 0;
    for (const component of scopedManifest.components) {
      const repo = component.allowedImageRepositories[0];
      const config = {
        Image: `${repo}:previous`,
        Labels: {
          'io.mergeron.managed': 'true',
          'io.mergeron.stack': scopedManifest.stack,
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

async function fixture(t, environment = 'production') {
  const scopedManifest = scopeManifest(
    JSON.parse(
      await readFile(new URL('../stack-manifest.json', import.meta.url)),
    ),
    environment === 'production' ? 'mergeron' : 'mergeron-dev',
    environment,
  );
  const root = await mkdtemp(join(tmpdir(), 'manager-update-'));
  let updater;
  t.after(async () => {
    // listBackups returns before its serialized size/cache writes finish.
    // Keep the fixture alive until all of its own work has settled; otherwise
    // teardown races backup-size.json creation and can fail with ENOTEMPTY.
    await updater?.task;
    await updater?.backupSizeTask;
    await rm(root, { recursive: true, force: true });
  });
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
  const docker = new Docker(root, scopedManifest);
  docker.root = root;
  const options = {
    manifest: scopedManifest,
    docker,
    configuration: { stateRoot: root, hostStatePath: root },
    adoptionPath: join(root, 'manager-state', 'adoption.json'),
    directory: join(root, 'manager-state', 'updates'),
    healthTimeoutMs: 10,
    pollMs: 1,
  };
  updater = new TransactionalUpdater(options);
  return { root, docker, updater, options };
}
async function begin(updater) {
  const plan = await updater.plan(images);
  assert.deepEqual(plan.blockers, []);
  await updater.begin({
    images,
    confirmation: plan.confirmation,
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
}

async function inspectBackup(t, updater) {
  const destination = await mkdtemp(join(tmpdir(), 'manager-inspect-'));
  await rm(destination, { recursive: true });
  t.after(() => rm(destination, { recursive: true, force: true }));
  const policy = recordedBackupPolicy(updater.current);
  const roots = (
    policy === 'minimal-v1'
      ? updater.current.backupScope
      : backupEntries(policy)
  ).filter((name) => !updater.current.backupMissing.includes(name));
  await extractBackupArchive({
    path: join(
      updater.directory,
      updater.current.id,
      'backup',
      BACKUP_ARCHIVE_NAME,
    ),
    destination,
    descriptor: updater.current.backupArchive,
    roots,
  });
  return destination;
}

// Manufacture a historical directory layout to keep its compatibility, size
// cache and deletion regressions exercised, while new transactions use archives.
async function legacyBackup(t, updater) {
  const content = await inspectBackup(t, updater);
  const backup = join(updater.directory, updater.current.id, 'backup');
  await rm(backup, { recursive: true });
  await rename(content, backup);
  delete updater.current.backupArchive;
  await updater.save(updater.current.phase, updater.current.status);
  return backup;
}

for (const environment of ['production', 'development']) {
  for (const backupMode of ['full', 'minimal', 'none']) {
    test(`${environment} explicitly selects ${backupMode}, recovers after restart and preserves excluded data`, async (t) => {
      const { updater, root, options } = await fixture(t, environment);
      const files = {
        'home/.codex/codex-webui.sqlite': 'database-before',
        'home/.codex/codex-webui.sqlite-wal': 'wal-before',
        'home/.codex/config.toml': 'configuration-before',
        'home/.codex/sessions/conversation.jsonl': 'conversation-before',
        'workspace/project/livrables/document.docx': 'document-before',
        'workspace/project/node_modules/cache': 'cache-before',
      };
      for (const [name, value] of Object.entries(files)) {
        await mkdir(join(root, name, '..'), { recursive: true });
        await writeFile(join(root, name), value);
      }
      const plan = await updater.plan(images, 'standard', backupMode);
      assert.deepEqual(plan.blockers, []);
      assert.equal(plan.backupPolicy, `${backupMode}-v1`);
      await assert.rejects(
        updater.begin({
          images,
          backupMode: backupMode === 'none' ? 'full' : 'none',
          confirmation: plan.confirmation,
          expectedFingerprint: plan.fingerprint,
        }),
        /ConfirmationRequired|PlanChanged/,
      );
      await updater.begin({
        images,
        backupMode,
        confirmation: plan.confirmation,
        expectedFingerprint: plan.fingerprint,
      });
      await updater.task;
      assert.equal(updater.current.status, 'succeeded');
      assert.equal(updater.current.backupComplete, backupMode !== 'none');
      if (backupMode === 'none')
        assert.equal(updater.current.backupArchive, undefined);
      else {
        assert.equal(updater.current.backupArchive.format, 'tar-gzip-v1');
        await assert.rejects(
          lstat(join(options.directory, updater.current.id, 'backup', 'home')),
          { code: 'ENOENT' },
        );
      }
      const backup =
        backupMode === 'none'
          ? join(options.directory, updater.current.id, 'backup')
          : await inspectBackup(t, updater);
      if (backupMode !== 'none') {
        assert.equal(
          await readFile(
            join(backup, 'home/.codex/codex-webui.sqlite'),
            'utf8',
          ),
          'database-before',
        );
      }
      if (backupMode === 'minimal') {
        for (const name of ['workspace', 'home/.codex/sessions'])
          await assert.rejects(lstat(join(backup, name)), { code: 'ENOENT' });
      }
      for (const name of Object.keys(files))
        await writeFile(join(root, name), 'after');
      // This sidecar was absent from the backup, and must not corrupt a restored DB.
      await writeFile(
        join(root, 'home/.codex/codex-webui.sqlite-shm'),
        'new-sidecar',
      );
      const recovered = new TransactionalUpdater(options);
      await recovered.recover();
      await recovered.requestRollback({
        operationId: recovered.current.id,
        confirmation: rollbackConfirmation(recovered.current.backupPolicy),
      });
      await recovered.task;
      assert.equal(recovered.current.status, 'rolledBack');
      for (const [name, value] of Object.entries(files)) {
        const included =
          backupMode === 'full' ||
          (backupMode === 'minimal' && /sqlite|config.toml/.test(name));
        assert.equal(
          await readFile(join(root, name), 'utf8'),
          included ? value : 'after',
          name,
        );
      }
      if (backupMode !== 'none')
        await assert.rejects(
          lstat(join(root, 'home/.codex/codex-webui.sqlite-shm')),
          { code: 'ENOENT' },
        );
      else
        assert.equal(
          await readFile(
            join(root, 'home/.codex/codex-webui.sqlite-shm'),
            'utf8',
          ),
          'new-sidecar',
        );
    });
  }
}

test('minimal mode rejects missing databases, linked parents and tampered restoration scopes', async (t) => {
  const { updater, root, options } = await fixture(t);
  assert.ok(
    (await updater.plan(images, 'standard', 'minimal')).blockers.includes(
      'updateMinimalDatabaseMissing',
    ),
  );
  await mkdir(join(root, 'home/.codex'));
  await writeFile(join(root, 'home/.codex/codex-webui.sqlite'), 'db');
  const plan = await updater.plan(images, 'standard', 'minimal');
  await updater.begin({
    images,
    backupMode: 'minimal',
    confirmation: plan.confirmation,
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  updater.current.backupScope.push('../../escape');
  updater.current.committed = false;
  updater.current.status = 'running';
  await updater.save('rollingBack');
  const recovered = new TransactionalUpdater(options);
  await recovered.recover();
  assert.equal(recovered.current.status, 'recoveryRequired');
  assert.equal(
    await readFile(join(root, 'home/.codex/codex-webui.sqlite'), 'utf8'),
    'db',
  );
});

test('minimal mode blocks symbolic links in configuration ancestors', async (t) => {
  const { root, updater } = await fixture(t);
  await symlink(join(root, 'workspace'), join(root, 'home/.codex'));
  await writeFile(join(root, 'workspace/codex-webui.sqlite'), 'outside');
  assert.ok(
    (await updater.plan(images, 'standard', 'minimal')).blockers.includes(
      'updateUnsafePath',
    ),
  );
});

test('minimal health failure restores database but keeps current documents and conversations', async (t) => {
  const { updater, root, docker } = await fixture(t);
  await mkdir(join(root, 'home/.codex/sessions'), { recursive: true });
  const db = join(root, 'home/.codex/codex-webui.sqlite');
  const conversation = join(root, 'home/.codex/sessions/thread.jsonl');
  await writeFile(db, 'before');
  await writeFile(conversation, 'before');
  docker.unhealthy = true;
  docker.afterStart = async (id) => {
    if (docker.values.get(id).Config.Labels['io.mergeron.transaction']) {
      await writeFile(db, 'migrated');
      await writeFile(conversation, 'current');
    }
  };
  const plan = await updater.plan(images, 'standard', 'minimal');
  await updater.begin({
    images,
    backupMode: 'minimal',
    confirmation: plan.confirmation,
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(await readFile(db, 'utf8'), 'before');
  assert.equal(await readFile(conversation, 'utf8'), 'current');
  assert.equal(
    await readFile(
      join(
        updater.directory,
        updater.current.id,
        'quarantine/home/.codex/codex-webui.sqlite',
      ),
      'utf8',
    ),
    'migrated',
  );
});

test('minimal image pull failure before container preparation never blocks later updates', async (t) => {
  const { updater, root, docker } = await fixture(t);
  await mkdir(join(root, 'home/.codex'));
  await writeFile(join(root, 'home/.codex/codex-webui.sqlite'), 'before');
  docker.pullFailure = true;
  const plan = await updater.plan(images, 'standard', 'minimal');
  await updater.begin({
    images,
    backupMode: 'minimal',
    confirmation: plan.confirmation,
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(updater.busy, false);
  assert.ok(!docker.calls.some(([action]) => action === 'stop'));
  assert.ok((await updater.plan(images, 'standard', 'minimal')).applicable);
});

test('a missing saved database blocks minimal rollback without deleting current data or stopping services', async (t) => {
  const { updater, root, docker } = await fixture(t);
  await mkdir(join(root, 'home/.codex'));
  await writeFile(join(root, 'home/.codex/codex-webui.sqlite'), 'before');
  const plan = await updater.plan(images, 'standard', 'minimal');
  await updater.begin({
    images,
    backupMode: 'minimal',
    confirmation: plan.confirmation,
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  await writeFile(join(root, 'home/.codex/codex-webui.sqlite'), 'current');
  await rm(
    join(
      updater.directory,
      updater.current.id,
      `backup/${BACKUP_ARCHIVE_NAME}`,
    ),
  );
  const callsBefore = docker.calls.length;
  await updater.requestRollback({
    operationId: updater.current.id,
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
  });
  await updater.task;
  assert.equal(updater.current.status, 'recoveryRequired');
  assert.equal(
    await readFile(join(root, 'home/.codex/codex-webui.sqlite'), 'utf8'),
    'current',
  );
  assert.ok(
    !docker.calls
      .slice(callsBefore)
      .some(([action]) => ['stop', 'remove'].includes(action)),
  );
});

test('a corrupt compressed backup blocks rollback before touching healthy services or live data', async (t) => {
  const { updater, root, docker } = await fixture(t);
  await begin(updater);
  const path = join(
    updater.directory,
    updater.current.id,
    'backup',
    BACKUP_ARCHIVE_NAME,
  );
  const bytes = await readFile(path);
  bytes[0] ^= 1;
  await writeFile(path, bytes);
  await writeFile(join(root, 'home/database'), 'current-data');
  const before = docker.calls.length;
  await updater.requestRollback({
    operationId: updater.current.id,
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
  });
  await updater.task;
  assert.equal(updater.current.status, 'recoveryRequired');
  assert.equal(updater.current.error, 'updateBackupArchiveCorrupt');
  assert.equal(
    await readFile(join(root, 'home/database'), 'utf8'),
    'current-data',
  );
  assert.ok(
    !docker.calls
      .slice(before)
      .some(([action]) => ['stop', 'remove'].includes(action)),
  );
  await assert.rejects(
    lstat(join(updater.directory, updater.current.id, 'restore-input')),
    { code: 'ENOENT' },
  );
});

test('compressed backups report exact file size without recursive statistics and reject unknown formats', async (t) => {
  const { updater } = await fixture(t);
  await begin(updater);
  updater.measureBackupSize = () =>
    assert.fail('compressed size must be obtained without scanning');
  const list = await updater.listBackups();
  assert.equal(list.sizesCalculating, false);
  assert.equal(list.backups[0].format, 'tar-gzip-v1');
  assert.equal(list.totalSizeBytes, updater.current.backupArchive.bytes);
  updater.current.backupArchive.format = 'unknown';
  const unsafe = await updater.listBackups();
  assert.equal(unsafe.backups[0].canDelete, false);
  assert.equal(unsafe.backups[0].restorable, false);
});

test('recovery discards a crashed extraction, restores the archive and removes scratch without removing the archive', async (t) => {
  const { updater, root, options } = await fixture(t);
  await begin(updater);
  const base = join(updater.directory, updater.current.id);
  await mkdir(join(base, 'restore-input/home'), { recursive: true });
  await writeFile(
    join(base, 'restore-input/home/database'),
    'untrusted-partial',
  );
  await chmod(join(base, 'restore-input/home'), 0o500);
  await writeFile(join(root, 'home/database'), 'migrated');
  updater.current.committed = false;
  updater.current.status = 'running';
  await updater.save('rollingBack');
  const recovered = new TransactionalUpdater(options);
  await recovered.recover();
  assert.equal(recovered.current.status, 'rolledBack');
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
  await assert.rejects(lstat(join(base, 'restore-input')), { code: 'ENOENT' });
  assert.ok((await lstat(join(base, 'backup', BACKUP_ARCHIVE_NAME))).isFile());
});

test(
  'minimal recovery restores private directory ownership after an interrupted permission adjustment',
  { skip: process.getuid() !== 0 },
  async (t) => {
    const { updater, root, options } = await fixture(t);
    const home = join(root, 'home/.codex');
    await mkdir(home);
    await writeFile(join(home, 'codex-webui.sqlite'), 'before');
    await chmod(home, 0o500);
    await chown(home, 11002, 11002);
    try {
      const info = await lstat(home);
      const plan = await updater.plan(images, 'standard', 'minimal');
      await updater.begin({
        images,
        backupMode: 'minimal',
        confirmation: plan.confirmation,
        expectedFingerprint: plan.fingerprint,
      });
      await updater.task;
      assert.equal(updater.current.status, 'succeeded');
      await writeFile(join(home, 'codex-webui.sqlite'), 'migrated');
      updater.current.restoreDirectoryMetadata = {
        'home/.codex': {
          uid: info.uid,
          gid: info.gid,
          mode: info.mode & 0o7777,
          dev: info.dev,
          ino: info.ino,
        },
      };
      updater.current.committed = false;
      updater.current.status = 'running';
      await updater.save('rollingBack');
      // Simulate death after the metadata was fsynced and the parent made writable.
      await chown(home, 0, 0);
      await chmod(home, 0o700);
      const recovered = new TransactionalUpdater(options);
      await recovered.recover();
      assert.equal(recovered.current.status, 'rolledBack');
      const restored = await lstat(home);
      assert.equal(restored.uid, 11002);
      assert.equal(restored.gid, 11002);
      assert.equal(restored.mode & 0o7777, 0o500);
      assert.equal(
        await readFile(join(home, 'codex-webui.sqlite'), 'utf8'),
        'before',
      );
    } finally {
      await chown(home, 0, 0);
      await chmod(home, 0o700);
    }
  },
);

test('DEV visual image migrates only target seccomp and restores the exact old profile on rollback', async (t) => {
  const { updater, docker } = await fixture(t, 'development');
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
    confirmation: rollbackConfirmation(recordedBackupPolicy(updater.current)),
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

for (const [environment, local] of [
  ['development', false],
  ['development', true],
  ['production', false],
])
  test(`managed ${environment} browser participates in update and rollback with persistent public DNS (local image: ${local})`, async (t) => {
    const { updater, docker } = await fixture(t, environment);
    const stack = updater.manifest.stack;
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
      canonicalName: `${stack}-browser`,
      stackName: stack,
      legacyNames: [],
      allowedImageRepositories: [
        'ghcr.io/maxhugit/mergeron-browser',
        ...(environment === 'development' ? ['mergeron-dev-browser'] : []),
      ],
      requiredNetworks: [`${stack}-browser-control`, `${stack}-browser-egress`],
      protectedMounts: [],
      dns: ['1.1.1.1'],
    };
    updater.manifest = {
      ...updater.manifest,
      environment,
      components: [...updater.manifest.components, browser],
    };
    docker.inspectNetwork = async (name) => ({
      Name: name,
      Driver: 'bridge',
      Internal: name.endsWith('-browser-control'),
    });
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
            'io.mergeron.stack': stack,
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
    // Reject network drift and all existing sandbox regressions before any stop.
    const originalBrowser = docker.values.get('original-browser');
    for (const change of [
      (c) => {
        c.HostConfig.Privileged = true;
      },
      (c) => {
        c.HostConfig.ReadonlyRootfs = false;
      },
      (c) => {
        c.HostConfig.CapAdd = ['SYS_ADMIN'];
      },
      (c) => {
        c.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '3000' }] };
      },
      (c) => {
        c.Mounts = [{ Source: '/secret', Destination: '/secret' }];
      },
      (c) => {
        c.Config.User = 'root';
      },
      (c) => {
        c.HostConfig.SecurityOpt = ['seccomp=unconfined'];
      },
      (c) => {
        c.NetworkSettings.Networks['other-egress'] = {};
      },
    ]) {
      const invalid = structuredClone(originalBrowser);
      change(invalid);
      docker.values.set('original-browser', invalid);
      assert.ok(
        (await updater.plan(images)).blockers.includes(
          'browser:updateIsolationRequired',
        ),
      );
    }
    docker.values.set('original-browser', originalBrowser);
    const inspectNetwork = docker.inspectNetwork;
    docker.inspectNetwork = async (name) => ({
      ...(await inspectNetwork(name)),
      Internal: false,
    });
    assert.ok(
      (await updater.plan(images)).blockers.includes(
        'browser:updateIsolationRequired',
      ),
    );
    docker.inspectNetwork = async () => {
      throw new Error('network unavailable');
    };
    assert.ok(
      (await updater.plan(images)).blockers.includes(
        'browser:updateIsolationRequired',
      ),
    );
    docker.inspectNetwork = inspectNetwork;
    await begin(updater);
    assert.equal(updater.current.status, 'succeeded');
    const active = () =>
      [...docker.values.values()].find((c) => c.Name === `/${stack}-browser`);
    assert.deepEqual(active().HostConfig.Dns, ['1.1.1.1']);
    assert.deepEqual(active().Config.Env, [
      'BROWSER_WS_PATH=' + 'x'.repeat(32),
    ]);
    const application = [...docker.values.values()].find(
      (c) => c.Name === `/${stack}-ui`,
    );
    assert.ok(
      application.Config.Env.includes(
        `MERGERON_BROWSER_ENDPOINT=ws://${stack}-browser:3000/` +
          'x'.repeat(32),
      ),
    );
    assert.ok(application.NetworkSettings.Networks[`${stack}-browser-control`]);
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
  const { updater } = await fixture(t, 'development');
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

test('fast dev update skips backup and inventory and rolls back images without reverting data', async (t) => {
  const { root, updater } = await fixture(t, 'development');
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
      confirmation: 'UPDATE_WITHOUT_DATA_BACKUP',
      expectedFingerprint: plan.fingerprint,
    }),
    /updatePlanChanged/,
  );
  await updater.begin({
    images,
    mode: 'dev-fast',
    confirmation: 'UPDATE_WITHOUT_DATA_BACKUP',
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  assert.equal(updater.current.status, 'succeeded');
  assert.equal(updater.current.backupComplete, false);
  assert.equal(plan.backupPolicy, 'development-none-v1');
  assert.deepEqual(plan.backupScope, []);
  assert.ok(
    !updater.current.events.some((event) => event.phase === 'backingUp'),
  );
  await assert.rejects(
    lstat(join(updater.directory, updater.current.id, 'backup')),
    { code: 'ENOENT' },
  );
  for (let n = 0; n < 24; n++)
    assert.equal(
      await readFile(join(root, 'workspace', `file-${n}`), 'utf8'),
      `original-${n}`,
    );
  await writeFile(join(root, 'home', 'database'), 'modified-after-update');
  await updater.requestRollback({
    operationId: updater.current.id,
    confirmation: 'ROLLBACK_IMAGES_ONLY',
  });
  await updater.task;
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(
    await readFile(join(root, 'home', 'database'), 'utf8'),
    'modified-after-update',
  );
});

test('fast mode reuses only a verified local immutable image, never a mutable tag', async (t) => {
  const { updater, docker } = await fixture(t, 'development');
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
    confirmation: 'UPDATE_WITHOUT_DATA_BACKUP',
    expectedFingerprint: plan.fingerprint,
  });
  await updater.task;
  assert.equal(updater.current.status, 'succeeded');
  assert.equal(docker.calls.filter(([action]) => action === 'pull').length, 0);
});

test('fast mode still pulls mutable tags and missing immutable images', async (t) => {
  for (const mutable of [true, false]) {
    const { updater, docker } = await fixture(t, 'development');
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
      confirmation: 'UPDATE_WITHOUT_DATA_BACKUP',
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

for (const mode of ['standard', 'dev-fast']) {
  test(`development ${mode} does not traverse source trees, create backups or prune old backups`, async (t) => {
    const { root, updater, options, docker } = await fixture(t, 'development');
    const unreadable = join(root, 'workspace', 'do-not-traverse');
    await mkdir(unreadable, { mode: 0o000 });
    const old = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await mkdir(join(options.directory, old, 'backup'), { recursive: true });
    await writeFile(
      join(options.directory, `${old}.json`),
      JSON.stringify({
        id: old,
        stack: 'mergeron-dev',
        environment: 'development',
        status: 'succeeded',
        backupComplete: true,
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await updater.setBackupRetention({ maxBackups: 1 });
    const plan = await updater.plan(images, mode);
    await assert.rejects(
      updater.begin({
        images,
        mode,
        confirmation: 'UPDATE_WITH_ROLLBACK',
        expectedFingerprint: plan.fingerprint,
      }),
      /ConfirmationRequired/,
    );
    try {
      await updater.begin({
        images,
        mode,
        confirmation: plan.confirmation,
        expectedFingerprint: plan.fingerprint,
      });
      await updater.task;
    } finally {
      await chmod(unreadable, 0o700);
    }
    assert.equal(updater.current.status, 'succeeded');
    assert.equal(updater.status().operation.backupRetained, false);
    assert.equal(updater.status().operation.rollbackAvailable, true);
    assert.ok(
      (await lstat(join(options.directory, old, 'backup'))).isDirectory(),
    );
    assert.ok(
      !updater.current.events.some((event) => event.phase === 'backingUp'),
    );
    assert.ok([...docker.values.values()].every((c) => c.State.Running));
  });
}

test('production backs up essential state, never regenerable trees, and restores the recorded scope', async (t) => {
  const { root, updater } = await fixture(t);
  const keep = [
    'home/.codex/sessions/conversation.jsonl',
    'workspace/project/documents/node_modules/document.txt',
    'workspace/project/livrables/result.pptx',
    'workspace/.mergeron-system/project/history/version.pptx',
    'workspace/.mergeron-agent-drafts/project/draft.txt',
    'workspace/project/sources/repo/.git/objects/local-commit',
    'workspace/project/sources/repo/unpublished.js',
    'workspace/project/sources/repo/dist/manual.txt',
  ];
  const skip = [
    'home/.cache/download',
    'workspace/project/sources/repo/node_modules/package/index.js',
    'workspace/project/sources/repo/.build-cache/result',
    'workspace/.mergeron-system/project/previews/run/source.tar',
    'logs/application.log',
  ];
  for (const name of [...keep, ...skip]) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), name, { mode: 0o600 });
  }
  await begin(updater);
  const backup = await inspectBackup(t, updater);
  assert.equal(updater.current.backupPolicy, 'production-essential-v1');
  for (const name of keep)
    assert.equal(await readFile(join(backup, name), 'utf8'), name);
  for (const name of skip)
    await assert.rejects(lstat(join(backup, name)), { code: 'ENOENT' });
  await writeFile(join(root, 'home/database'), 'migrated');
  await writeFile(join(root, 'logs/application.log'), 'new-log');
  await updater.requestRollback({
    operationId: updater.current.id,
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
  });
  await updater.task;
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'original');
  assert.equal(
    await readFile(join(root, 'logs/application.log'), 'utf8'),
    'new-log',
  );
  for (const name of keep)
    assert.equal(await readFile(join(root, name), 'utf8'), name);
});

test('a failed development health check returns to old images without pretending to restore migrated data', async (t) => {
  const { root, updater, docker, options } = await fixture(t, 'development');
  docker.unhealthy = true;
  await begin(updater);
  assert.equal(updater.current.status, 'rolledBack');
  assert.equal(updater.status().operation.backupRetained, false);
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'migrated');
  const recovered = new TransactionalUpdater(options);
  await recovered.recover();
  assert.equal(
    recovered.status().operation.backupPolicy,
    'development-none-v1',
  );
  assert.equal(await readFile(join(root, 'home/database'), 'utf8'), 'migrated');
});

test('recovery of a historical full backup still restores logs and caches under the new defaults', async (t) => {
  const { root, updater, options } = await fixture(t);
  await writeFile(join(root, 'logs/previous.log'), 'old-log');
  await begin(updater);
  const backup = await legacyBackup(t, updater);
  await copyPersistentTree(join(root, 'logs'), join(backup, 'logs'));
  await mkdir(join(backup, 'home/.cache'));
  await writeFile(join(backup, 'home/.cache/historical'), 'old-cache');
  delete updater.current.backupPolicy; // A journal written before versioned policies existed.
  await writeFile(
    join(updater.directory, 'transaction.json'),
    JSON.stringify(updater.current),
  );
  await writeFile(join(root, 'logs/previous.log'), 'new-log');
  const recovered = new TransactionalUpdater(options);
  await recovered.recover();
  assert.equal(recovered.status().operation.backupPolicy, 'legacy-full-v1');
  await recovered.requestRollback({
    operationId: recovered.current.id,
    confirmation: 'ROLLBACK_WITH_DATA_RESTORE',
  });
  await recovered.task;
  assert.equal(recovered.current.status, 'rolledBack');
  assert.equal(
    await readFile(join(root, 'logs/previous.log'), 'utf8'),
    'old-log',
  );
  assert.equal(
    await readFile(join(root, 'home/.cache/historical'), 'utf8'),
    'old-cache',
  );
});

test('restart of a development transaction recovers images only; a corrupt policy blocks recovery', async (t) => {
  const { root, updater, options, docker } = await fixture(t, 'development');
  await begin(updater);
  await writeFile(join(root, 'home/database'), 'migration-kept');
  updater.current.committed = false;
  updater.current.status = 'running';
  updater.current.phase = 'checkingHealth';
  await writeFile(
    join(updater.directory, 'transaction.json'),
    JSON.stringify(updater.current),
  );
  const recovered = new TransactionalUpdater(options);
  await recovered.recover();
  assert.equal(recovered.current.status, 'rolledBack');
  assert.equal(
    await readFile(join(root, 'home/database'), 'utf8'),
    'migration-kept',
  );
  recovered.current.backupPolicy = 'unknown-policy';
  await writeFile(
    join(updater.directory, 'transaction.json'),
    JSON.stringify(recovered.current),
  );
  const calls = docker.calls.length;
  await assert.rejects(
    new TransactionalUpdater(options).recover(),
    /BackupPolicyInvalid/,
  );
  assert.equal(docker.calls.length, calls);
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
    join(options.directory, list.backups[0].id, 'backup', BACKUP_ARCHIVE_NAME),
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
  const backup = await legacyBackup(t, updater);
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
  const directory = await legacyBackup(t, updater);
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
  assert.ok(result.backups[0].managerPath.endsWith('/backup/backup.tar.gz'));
});

test('finishes slow size scans in background without blocking or restarting on repeated lists', async (t) => {
  const { updater } = await fixture(t);
  await begin(updater);
  await legacyBackup(t, updater);
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
  await legacyBackup(t, updater);
  await begin(updater);
  await legacyBackup(t, updater);
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

test('completed sizes survive a Manager restart without scanning backup contents or changing journals', async (t) => {
  const { updater, options } = await fixture(t);
  await begin(updater);
  await legacyBackup(t, updater);
  const journal = join(options.directory, 'transaction.json');
  const before = await readFile(journal, 'utf8');
  updater.measureBackupSize = async () => 12345;
  await updater.listBackups();
  await updater.backupSizeTask;
  const restarted = new TransactionalUpdater(options);
  await restarted.recover();
  let scans = 0;
  restarted.measureBackupSize = async () => {
    scans++;
    assert.fail('a completed backup must not be rescanned after a restart');
  };
  await restarted.listBackups();
  await restarted.backupSizeTask;
  assert.equal((await restarted.listBackups()).totalSizeBytes, 12345);
  assert.equal(scans, 0);
  assert.equal(await readFile(journal, 'utf8'), before);
});

test('invalid cached metadata is ignored and regenerated from the exact backup', async (t) => {
  const { updater, options } = await fixture(t);
  await begin(updater);
  await legacyBackup(t, updater);
  const path = join(options.directory, updater.current.id, 'backup-size.json');
  await writeFile(
    path,
    JSON.stringify({ schema: 1, stack: 'other', bytes: 999 }),
  );
  let scans = 0;
  updater.measureBackupSize = async () => {
    scans++;
    return 512;
  };
  await updater.listBackups();
  await updater.backupSizeTask;
  assert.equal(scans, 1);
  assert.equal((await updater.listBackups()).totalSizeBytes, 512);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).stack, manifest.stack);
});

test('size queue yields to an update and retries later without caching partial results', async (t) => {
  const { updater, options } = await fixture(t);
  await begin(updater);
  await legacyBackup(t, updater);
  let entered;
  let resume;
  const scanning = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  updater.measureBackupSize = async (_, { check }) => {
    entered();
    await gate;
    check();
    return 123;
  };
  await updater.listBackups();
  await scanning;
  updater.busy = true;
  resume();
  await updater.backupSizeTask;
  const path = join(options.directory, updater.current.id, 'backup-size.json');
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal((await updater.listBackups()).totalSizeBytes, null);
  updater.busy = false;
  updater.measureBackupSize = async () => 456;
  await updater.listBackups();
  await updater.backupSizeTask;
  assert.equal((await updater.listBackups()).totalSizeBytes, 456);
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
