import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PreviewManager, previewCatalog } from '../src/previews.mjs';
import http from 'node:http';
import archives from '../../runtime/preview-archive.cjs';
import storage from '../../runtime/preview-storage.cjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const image = 'example.org/node@sha256:' + 'a'.repeat(64);
class Docker {
  constructor() {
    this.containers = new Map();
    this.networks = new Map();
    this.volumes = new Map();
    this.created = [];
    this.calls = [];
    this.version = '28.2.2';
    this.httpStatus = 200;
  }
  async inspectContainer(id) {
    if (id === 'stack-ui')
      return {
        Config: {
          Labels: {
            'io.mergeron.managed': 'true',
            'io.mergeron.stack': 'stack',
            'io.mergeron.component': 'application',
          },
        },
        Mounts: [
          {
            Type: 'bind',
            Destination: '/workspaces',
            Source: '/state/workspace',
          },
        ],
      };
    if (id === 'self')
      return {
        Image: 'sha256:' + 'b'.repeat(64),
        Config: {
          Labels: {
            'io.mergeron.stack': 'stack',
            'io.mergeron.component': 'manager',
          },
        },
      };
    if (!this.containers.has(id))
      throw Object.assign(Error('missing'), { statusCode: 404 });
    return this.containers.get(id);
  }
  async inspectImage() {
    return { Os: 'linux' };
  }
  async createContainer(name, spec) {
    const id = randomUUID(),
      c = {
        Id: id,
        Names: ['/' + name],
        Config: { ...spec },
        Image: spec.Image,
        State: { Running: false },
      };
    this.containers.set(id, c);
    this.created.push(c);
    if (this.failCreate) {
      this.failCreate = false;
      throw Error('lost creation acknowledgement');
    }
    return { Id: id };
  }
  async startContainer(id) {
    const container = this.containers.get(id);
    container.State.Running = true;
    if (container.Config.Labels['io.mergeron.component'] === 'preview-relay') {
      container.State.Health = this.health();
    }
  }
  health() {
    const ready = this.httpStatus >= 200 && this.httpStatus < 400;
    return {
      Status: ready ? 'healthy' : 'unhealthy',
      Log: [
        {
          End: new Date().toISOString(),
          ExitCode: ready ? 0 : 1,
          Output: JSON.stringify({ ready, httpStatus: this.httpStatus }),
        },
      ],
    };
  }
  async stopContainer(id) {
    this.containers.get(id).State.Running = false;
  }
  async removeContainer(id) {
    assert.equal(this.containers.get(id)?.State.Running, false);
    this.containers.delete(id);
  }
  async waitContainer(id) {
    this.containers.get(id).State.Running = false;
    return { StatusCode: this.failHelper ? 1 : 0 };
  }
  async putArchive(id, buffer, destination = '/workspace') {
    assert.ok(this.containers.has(id));
    assert.equal(this.containers.get(id).State.Running, true);
    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(['/workspace', '/control'].includes(destination));
  }
  async containerLogs(id) {
    if (
      this.containers.get(id)?.Config.Labels['io.mergeron.component'] ===
      'preview-volume'
    )
      return this.storageLog ?? '';
    return 'application output';
  }
  async createNetwork(spec) {
    this.networks.set(spec.Name, { ...spec, Containers: {} });
  }
  async inspectNetwork(name) {
    if (!this.networks.has(name))
      throw Object.assign(Error('missing'), { statusCode: 404 });
    return this.networks.get(name);
  }
  async request(url, options = {}) {
    this.calls.push({ url, options });
    const p = new URL(url, 'http://docker');
    if (p.pathname === '/version') return { Version: this.version };
    if (p.pathname === '/volumes/create') {
      const body = options.body,
        v = {
          Name: body.Name,
          Labels: body.Labels,
          Driver: body.Driver,
          Options: body.DriverOpts,
        };
      this.volumes.set(v.Name, v);
      return v;
    }
    const filtered = (values) => {
      const f = JSON.parse(p.searchParams.get('filters'));
      return values.filter((v) =>
        f.label.every((x) => {
          const [k, value] = x.split('=');
          return (v.Labels ?? v.Config?.Labels)?.[k] === value;
        }),
      );
    };
    if (p.pathname === '/containers/json')
      return filtered([...this.containers.values()]).map((c) => ({
        ...c,
        Labels: c.Config.Labels,
      }));
    if (p.pathname === '/networks')
      return filtered([...this.networks.values()]);
    if (p.pathname === '/volumes')
      return { Volumes: filtered([...this.volumes.values()]) };
    const name = decodeURIComponent(p.pathname.split('/')[2]);
    if (p.pathname.startsWith('/volumes/')) {
      if (options.method === 'DELETE') {
        this.volumes.delete(name);
        return;
      }
      if (!this.volumes.has(name))
        throw Object.assign(Error(), { statusCode: 404 });
      return this.volumes.get(name);
    }
    if (p.pathname.startsWith('/networks/') && options.method === 'DELETE') {
      this.networks.delete(name);
      return;
    }
    throw Error('Unexpected Docker request ' + p.pathname);
  }
}
async function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mergeron-preview-manager-')),
  );
  roots.push(root);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.html'), '<h1>project A</h1>');
  const env = {
    MERGERON_PREVIEWS_ENABLED: 'true',
    MERGERON_PREVIEW_DOMAIN: 'preview.example.org',
    MERGERON_PREVIEW_IMAGES: JSON.stringify({ node: { image } }),
  };
  const docker = new Docker(),
    configuration = {
      stateRoot: '/state',
      hostStatePath: root,
      previewJournal: path.join(root, 'journal'),
      publicUrl: 'https://mergeron.example.org',
    };
  const manifest = {
    stack: 'stack',
    components: [{ id: 'application', canonicalName: 'stack-ui' }],
    networks: [{ id: 'admin', name: 'stack-admin' }],
  };
  const manager = new PreviewManager({
    docker,
    manifest,
    configuration,
    env,
    self: 'self',
  });
  await manager.ready;
  const exportSource = (snapshotId = randomUUID()) => {
    const target = path.join(
      root,
      'workspace',
      '.mergeron-system',
      'project',
      'previews',
      snapshotId,
    );
    fs.mkdirSync(target, { recursive: true });
    const tar = execFileSync('python3', [
      '-I',
      path.resolve('runtime/preview-snapshot.py'),
      source,
    ]);
    fs.writeFileSync(path.join(target, 'source.tar'), tar);
    return {
      snapshotId,
      sourceSha: createHash('sha256').update(tar).digest('hex'),
      tar,
    };
  };
  const snapshot = exportSource(),
    input = {
      projectId: 'project',
      agentId: 'agent',
      runId: snapshot.snapshotId,
      previewId: randomUUID(),
      sourceSha: snapshot.sourceSha,
      profile: { enabled: true, runtime: 'node', start: 'node server.js' },
    };
  return {
    root,
    source,
    env,
    docker,
    configuration,
    manifest,
    manager,
    input,
    exportSource,
    snapshot,
  };
}
test('disabled catalog does not approve arbitrary images, root users or Docker fields', () => {
  assert.deepEqual(previewCatalog({}), {});
  for (const item of [
    { image: 'node:latest' },
    { image, user: '0:0' },
    { image, mounts: ['/var/run/docker.sock'] },
    { image, tmpfs: ['/etc'] },
  ])
    assert.throws(() =>
      previewCatalog({
        MERGERON_PREVIEWS_ENABLED: 'true',
        MERGERON_PREVIEW_IMAGES: JSON.stringify({ node: item }),
      }),
    );
});
test('starts a generic source snapshot with no host mounts, published ports, root user or added capabilities', async () => {
  const f = await fixture(),
    result = await f.manager.start(f.input);
  assert.equal(result.state, 'running');
  assert.equal(
    result.url,
    'https://' + f.input.previewId + '.preview.example.org/',
  );
  assert.ok(!('token' in result));
  assert.ok(!('endpoint' in result));
  const transport = await f.manager.transport(f.input.runId);
  const alias = `pv-${f.input.runId.replaceAll('-', '')}-relay`;
  assert.equal(transport.endpoint, `http://${alias}:8180`);
  const relay = f.docker.created.find(
    (c) => c.Config.Labels['io.mergeron.component'] === 'preview-relay',
  );
  assert.ok(
    relay.Config.Env.includes('MERGERON_PREVIEW_RUN_ID=' + f.input.runId),
  );
  assert.ok(
    relay.Config.Env.includes(
      'MERGERON_PREVIEW_PUBLIC_HOST=' +
        f.input.previewId +
        '.preview.example.org',
    ),
  );
  assert.ok(
    Object.values(relay.Config.NetworkingConfig.EndpointsConfig).every((n) =>
      n.Aliases.includes(alias),
    ),
  );
  assert.ok(alias.length < 63);
  for (const c of f.docker.created) {
    assert.equal(c.Config.User, '11002:11002');
    const h = c.Config.HostConfig;
    assert.equal(h.ReadonlyRootfs, true);
    assert.deepEqual(h.CapDrop, ['ALL']);
    assert.ok(!h.CapAdd);
    assert.ok(!h.Binds);
    assert.ok(!h.PortBindings);
    assert.ok(h.Mounts?.every((m) => m.Type === 'volume') ?? true);
    if (c.Config.Image !== image) {
      assert.match(h.Tmpfs['/run/mergeron-manager'], /^ro,/);
      assert.match(h.Tmpfs['/var/lib/mergeron-manager'], /^ro,/);
    }
  }
  const runtime = f.docker.created.find(
    (c) => c.Config.Labels['io.mergeron.component'] === 'preview-app',
  );
  assert.deepEqual(runtime.Config.HostConfig.Dns, ['127.0.0.1']);
  assert.ok(runtime.Config.Env.includes('NODE_USE_ENV_PROXY=1'));
  assert.ok(runtime.Config.Env.includes('HTTP_PROXY=http://egress:3129'));
  assert.ok(runtime.Config.Env.includes('HTTPS_PROXY=http://egress:3129'));
  for (const [key, value] of Object.entries(storage.cacheEnvironment))
    assert.ok(runtime.Config.Env.includes(`${key}=${value}`));
  assert.equal(
    runtime.Config.HostConfig.Mounts.find((m) => m.Target === '/cache').Type,
    'volume',
  );
  assert.equal(
    runtime.Config.HostConfig.Mounts.find((m) => m.Target === '/tmp').Type,
    'volume',
  );
  assert.equal(runtime.Config.HostConfig.Tmpfs['/tmp'], undefined);
  const keeper = f.docker.created.find(
    (c) => c.Config.Labels['io.mergeron.component'] === 'preview-volume',
  );
  assert.ok(keeper.Config.HostConfig.Mounts.every((m) => m.ReadOnly));
  assert.equal(keeper.Config.HostConfig.NetworkMode, 'none');
  assert.equal(
    Object.keys(runtime.Config.NetworkingConfig.EndpointsConfig).length,
    1,
  );
  const egress = f.docker.created.find(
    (c) => c.Config.Labels['io.mergeron.component'] === 'preview-egress',
  );
  assert.deepEqual(egress.Config.HostConfig.Dns, []);
  assert.ok(
    egress.Config.Env.some((v) =>
      v.startsWith('MERGERON_PREVIEW_ALLOWED_DOMAINS=registry.npmjs.org,'),
    ),
  );
  const network = [...f.docker.networks.values()].find((n) => n.Internal);
  assert.equal(
    network.Options['com.docker.network.bridge.gateway_mode_ipv4'],
    'isolated',
  );
  const volume = [...f.docker.volumes.values()][0];
  assert.equal(volume.Options.type, 'tmpfs');
  assert.match(volume.Options.o, /size=4096m,nr_inodes=524288/);
  assert.deepEqual(result.storage.limits, storage.previewStorage);
});

test('storage evidence is sampled from our read-only helper, survives stop, and is not taken from app logs', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  f.docker.storageLog = JSON.stringify({
    version: 1,
    checkedAt: Date.now(),
    mounts: storage.storageMounts.map((m) => ({
      role: m.role,
      totalBytes: 1024,
      availableBytes: m.role === 'cache' ? 0 : 1024,
      totalInodes: 100,
      availableInodes: 90,
      extra: 'must-not-escape',
    })),
  });
  const live = await f.manager.status(f.input.runId);
  assert.equal(live.storage.observation.mounts[1].cause, 'space_exhausted');
  assert.equal(JSON.stringify(live).includes('must-not-escape'), false);
  const stopped = await f.manager.stop(f.input.runId);
  assert.deepEqual(stopped.storage.observation, live.storage.observation);
  assert.equal(stopped.cleanupComplete, true);
  assert.equal(f.docker.volumes.size, 0);
});

test('a runtime OOM is distinguished from storage exhaustion', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  const runtime = f.docker.created.find(
    (c) => c.Config.Labels['io.mergeron.component'] === 'preview-app',
  );
  runtime.State.Running = false;
  runtime.State.OOMKilled = true;
  assert.equal(
    (await f.manager.status(f.input.runId)).error,
    'PREVIEW_MEMORY_LIMIT',
  );
});
test('idempotent start cannot create a second copy, and changed input is rejected', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  const count = f.docker.created.length;
  await f.manager.start(f.input);
  assert.equal(f.docker.created.length, count);
  await assert.rejects(
    () =>
      f.manager.start({
        ...f.input,
        profile: { ...f.input.profile, start: 'other' },
      }),
    /PREVIEW_REQUEST_CONFLICT/,
  );
  await assert.rejects(
    () => f.manager.start({ ...f.input, runId: randomUUID() }),
    /PREVIEW_ALREADY_RUNNING/,
  );
});
test('hot synchronization updates the source revision without recreating the runtime', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  const runtime = f.manager.records.get(f.input.runId).runtimeId;
  fs.writeFileSync(
    path.join(f.source, 'index.html'),
    '<h1>changed without commit</h1>',
  );
  const next = f.exportSource();
  const result = await f.manager.sync({
    runId: f.input.runId,
    snapshotId: next.snapshotId,
    sourceSha: next.sourceSha,
  });
  assert.equal(result.sourceSha, next.sourceSha);
  assert.equal(f.manager.records.get(f.input.runId).runtimeId, runtime);
  assert.equal(f.docker.containers.get(runtime).State.Running, true);
  assert.ok(
    ![...f.docker.containers.values()].some((c) =>
      c.Config.Labels['io.mergeron.component'].startsWith('preview-sync-'),
    ),
  );
});
test('requires isolated gateway support and cleans up failed creation, including a lost acknowledgement', async () => {
  const f = await fixture();
  f.docker.version = '27.5.0';
  await assert.rejects(
    () => f.manager.start(f.input),
    /PREVIEW_DOCKER_UPGRADE_REQUIRED/,
  );
  assert.equal(f.docker.created.length, 0);
  const other = await fixture();
  other.docker.failCreate = true;
  await assert.rejects(
    () => other.manager.start(other.input),
    /PREVIEW_START_FAILED/,
  );
  assert.equal(other.docker.containers.size, 0);
  assert.equal(other.docker.volumes.size, 0);
  assert.equal(other.docker.networks.size, 0);
});
test('stopping removes only this run, never another stack or backup', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  f.docker.volumes.set('production-data', {
    Name: 'production-data',
    Driver: 'local',
    Labels: { 'io.mergeron.stack': 'production' },
  });
  const stopped = await f.manager.stop(f.input.runId);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.cleanupComplete, true);
  assert.equal(f.docker.containers.size, 0);
  assert.deepEqual([...f.docker.volumes.keys()], ['production-data']);
  assert.equal(f.docker.networks.size, 0);
  assert.ok(fs.existsSync(path.join(f.source, 'index.html')));
  assert.ok(
    fs.existsSync(
      path.join(f.configuration.previewJournal, f.input.runId + '.json'),
    ),
  );
  assert.equal((await f.manager.stop(f.input.runId)).cleanupComplete, true);
});
test('partial or refused cleanup never reports the runtime resources removed', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  assert.equal((await f.manager.status(f.input.runId)).cleanupComplete, false);
  f.docker.removeContainer = async () => {
    throw Error('Docker removal refused');
  };
  await assert.rejects(
    () => f.manager.stop(f.input.runId),
    /Docker removal refused/,
  );
  assert.equal((await f.manager.status(f.input.runId)).cleanupComplete, false);
  assert.ok(f.docker.containers.size > 0);
  assert.ok(f.docker.volumes.size > 0);
});
test('recovers running jobs across Manager restart and refuses changed ownership before deletion', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  const restarted = new PreviewManager({
    docker: f.docker,
    manifest: f.manifest,
    configuration: f.configuration,
    env: f.env,
    self: 'self',
  });
  await restarted.ready;
  assert.equal((await restarted.status(f.input.runId)).state, 'running');
  const c = [...f.docker.containers.values()][0];
  c.Config.Labels['io.mergeron.stack'] = 'production';
  await assert.rejects(
    () => restarted.stop(f.input.runId),
    /PREVIEW_OBJECT_CHANGED/,
  );
  assert.ok(f.docker.containers.size > 0);
});
test('does not announce a URL until the application answers HTTP, not only Docker running', async () => {
  const f = await fixture();
  f.docker.httpStatus = 503;
  const starting = await f.manager.start(f.input);
  assert.equal(starting.state, 'running');
  assert.equal(starting.ready, false);
  assert.equal(starting.url, null);
  f.docker.httpStatus = 200;
  const relay = f.docker.created.find(
    (c) => c.Config.Labels['io.mergeron.component'] === 'preview-relay',
  );
  relay.State.Health = f.docker.health();
  const ready = await f.manager.status(f.input.runId);
  assert.equal(ready.ready, true);
  assert.equal(ready.url, `https://${f.input.previewId}.preview.example.org/`);
  await f.manager.stop(f.input.runId);
});
test('recreating an agent preview retains its public URL but replaces private runtime resources', async () => {
  const f = await fixture();
  const first = await f.manager.start(f.input);
  const oldTransport = await f.manager.transport(f.input.runId);
  await f.manager.stop(f.input.runId);
  const next = f.exportSource();
  const input = {
    ...f.input,
    runId: next.snapshotId,
    sourceSha: next.sourceSha,
  };
  const recreated = await f.manager.start(input);
  const transport = await f.manager.transport(input.runId);
  assert.equal(recreated.url, first.url);
  assert.equal(transport.publicHost, oldTransport.publicHost);
  assert.notEqual(transport.endpoint, oldTransport.endpoint);
  assert.notEqual(transport.token, oldTransport.token);
  await f.manager.stop(input.runId);
  assert.equal((await f.manager.status(input.runId)).cleanupComplete, true);
  await assert.rejects(
    () =>
      f.manager.start({
        ...input,
        agentId: 'different-agent',
        runId: randomUUID(),
      }),
    /PREVIEW_IDENTITY_CHANGED/,
  );
});
test('readiness never opens a network socket in the Manager and runs the fixed probe in its owned relay', async (t) => {
  const f = await fixture();
  const request = t.mock.method(http, 'request', () => {
    throw Error('networkless Manager must not connect');
  });
  const result = await f.manager.start(f.input);
  assert.equal(result.ready, true);
  assert.equal(request.mock.callCount(), 0);
  const relay = f.docker.created.find(
    (c) => c.Config.Labels['io.mergeron.component'] === 'preview-relay',
  );
  assert.deepEqual(relay.Config.Healthcheck.Test, [
    'CMD',
    '/nodejs/bin/node',
    '/opt/mergeron-manager/src/preview-health-probe.mjs',
  ]);
  assert.equal(relay.Config.Healthcheck.Timeout, 2_000_000_000);
  assert.ok(relay.Config.Env.includes('MERGERON_PREVIEW_HEALTH_PATH=/'));
  relay.Config.Labels['io.mergeron.stack'] = 'another-stack';
  await assert.rejects(
    () => f.manager.status(f.input.runId),
    /PREVIEW_OBJECT_CHANGED/,
  );
  relay.Config.Labels['io.mergeron.stack'] = 'stack';
  await f.manager.stop(f.input.runId);
});
test('archive parser rejects traversal, links and corrupt checksums', async () => {
  const f = await fixture();
  assert.equal(
    archives.entries(f.snapshot.tar).find((e) => e.type === 'file').name,
    'index.html',
  );
  for (const name of [
    '../outside',
    '/etc/passwd',
    'a//b',
    'a/../b',
    'a\\b',
    '.mergeron-system/x',
  ])
    assert.throws(() => archives.safeName(name));
  const broken = Buffer.from(f.snapshot.tar);
  broken[0] ^= 1;
  assert.throws(() => archives.entries(broken), /PREVIEW_UNSAFE_ARCHIVE/);
});

test('async snapshot validation preserves the buffer, digest and link protections before creating resources', async () => {
  const f = await fixture();
  const snapshot = () =>
    f.manager.snapshot(
      { projectId: 'project' },
      f.input.runId,
      f.input.sourceSha,
    );
  const result = await snapshot();
  assert.ok(Buffer.isBuffer(result.archive));
  assert.deepEqual(result.archive, f.snapshot.tar);
  assert.deepEqual(
    result.entries,
    archives.entries(f.snapshot.tar).filter((e) => e.type === 'file'),
  );
  await assert.rejects(
    f.manager.snapshot({ projectId: 'project' }, f.input.runId, '0'.repeat(64)),
    /PREVIEW_STALE_SNAPSHOT/,
  );
  const name = path.join(
    f.root,
    'workspace',
    '.mergeron-system',
    'project',
    'previews',
    f.input.runId,
    'source.tar',
  );
  const broken = Buffer.from(f.snapshot.tar);
  broken[0] ^= 1;
  fs.writeFileSync(name, broken);
  await assert.rejects(
    f.manager.snapshot(
      { projectId: 'project' },
      f.input.runId,
      createHash('sha256').update(broken).digest('hex'),
    ),
    /PREVIEW_UNSAFE_ARCHIVE/,
  );
  const original = name + '.original';
  fs.renameSync(name, original);
  fs.symlinkSync(original, name);
  await assert.rejects(snapshot());
  fs.unlinkSync(name);
  fs.linkSync(original, name);
  await assert.rejects(snapshot(), /PREVIEW_UNSAFE_SNAPSHOT/);
  assert.equal(f.docker.created.length, 0);
  assert.equal(f.docker.volumes.size, 0);
});

test('start and synchronization await rejected snapshots before creating any Docker resource', async () => {
  const f = await fixture();
  await assert.rejects(
    f.manager.start({ ...f.input, sourceSha: '0'.repeat(64) }),
    /PREVIEW_STALE_SNAPSHOT/,
  );
  assert.equal(f.docker.created.length, 0);
  assert.equal(f.docker.networks.size, 0);
  assert.equal(f.docker.volumes.size, 0);
  const valid = await fixture();
  await valid.manager.start(valid.input);
  const resources = valid.docker.created.length;
  const next = valid.exportSource();
  await assert.rejects(
    valid.manager.sync({
      runId: valid.input.runId,
      snapshotId: next.snapshotId,
      sourceSha: '0'.repeat(64),
    }),
    /PREVIEW_STALE_SNAPSHOT/,
  );
  assert.equal(valid.docker.created.length, resources);
});

test('lifetime changes persist without recreating resources; unlimited still uses finite access grants', async () => {
  const f = await fixture();
  const initial = await f.manager.start(f.input);
  assert.equal(initial.lifetimeMinutes, 300);
  const resources = f.docker.created.length;
  const requestId = randomUUID();
  const unlimited = await f.manager.setLifetime({
    runId: f.input.runId,
    requestId,
    lifetimeMinutes: null,
  });
  assert.equal(unlimited.expiresAt, null);
  assert.equal(unlimited.lifetimeMinutes, null);
  assert.equal(unlimited.runId, initial.runId);
  assert.equal(unlimited.sourceSha, initial.sourceSha);
  assert.equal(f.docker.created.length, resources);
  const grant = await f.manager.transport(f.input.runId);
  assert.ok(Number.isFinite(grant.expiresAt));
  assert.ok(grant.expiresAt <= Date.now() + 30 * 60000);
  await f.manager.expire();
  assert.equal((await f.manager.status(f.input.runId)).state, 'running');
  const recovered = new PreviewManager({
    docker: f.docker,
    manifest: f.manifest,
    configuration: f.configuration,
    env: f.env,
    self: 'self',
  });
  await recovered.ready;
  assert.equal((await recovered.status(f.input.runId)).expiresAt, null);
  const change = {
    runId: f.input.runId,
    requestId: randomUUID(),
    lifetimeMinutes: 60,
  };
  const finite = await recovered.setLifetime(change);
  assert.ok(Math.abs(finite.expiresAt - Date.now() - 3600000) < 1000);
  assert.equal(
    (await recovered.setLifetime(change)).expiresAt,
    finite.expiresAt,
  );
  await assert.rejects(
    () => recovered.setLifetime({ ...change, lifetimeMinutes: 180 }),
    /PREVIEW_REQUEST_CONFLICT/,
  );
  for (const lifetimeMinutes of [0, 61, '300', undefined])
    await assert.rejects(
      () =>
        recovered.setLifetime({
          ...change,
          requestId: randomUUID(),
          lifetimeMinutes,
        }),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
  recovered.records.get(f.input.runId).expiresAt = Date.now() - 1;
  await assert.rejects(
    () => recovered.setLifetime({ ...change, requestId: randomUUID() }),
    /PREVIEW_EXPIRED/,
  );
  await recovered.expire();
  assert.equal((await recovered.status(f.input.runId)).cleanupComplete, true);
});

test('an unlimited environment can be selected at launch and stopped manually', async () => {
  const f = await fixture();
  const result = await f.manager.start({
    ...f.input,
    profile: { ...f.input.profile, lifetimeMinutes: null },
  });
  assert.equal(result.state, 'running');
  assert.equal(result.expiresAt, null);
  await f.manager.stop(f.input.runId);
  assert.equal((await f.manager.status(f.input.runId)).cleanupComplete, true);
});

test('deleting an unlimited preview removes runtime and journal, with safe retry', async () => {
  const f = await fixture();
  f.input.profile.lifetimeMinutes = null;
  await f.manager.start(f.input);
  const journal = path.join(
    f.configuration.previewJournal,
    f.input.runId + '.json',
  );
  assert.equal(fs.existsSync(journal), true);
  assert.deepEqual(await f.manager.deleteAgent(f.input), {
    deleted: true,
    cleanupComplete: true,
  });
  assert.equal(f.docker.containers.size, 0);
  assert.equal(f.docker.volumes.size, 0);
  assert.equal(f.docker.networks.size, 0);
  assert.equal(fs.existsSync(journal), false);
  assert.equal(f.manager.records.has(f.input.runId), false);
  assert.deepEqual(await f.manager.deleteAgent(f.input), {
    deleted: true,
    cleanupComplete: true,
  });
});
test('failed preview deletion keeps its journal for retry', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  const container = [...f.docker.containers.values()][0];
  container.Config.Labels = {};
  await assert.rejects(
    () => f.manager.deleteAgent(f.input),
    /PREVIEW_OBJECT_CHANGED/,
  );
  assert.equal(
    fs.existsSync(
      path.join(f.configuration.previewJournal, f.input.runId + '.json'),
    ),
    true,
  );
  assert.equal(f.manager.records.has(f.input.runId), true);
});

test('agent deletion purges previous runs and preserves other agents', async () => {
  const f = await fixture();
  await f.manager.start(f.input);
  await f.manager.stop(f.input.runId);
  const next = f.exportSource();
  const current = {
    ...f.input,
    runId: next.snapshotId,
    sourceSha: next.sourceSha,
  };
  await f.manager.start(current);
  const otherId = randomUUID();
  const previous = f.manager.records.get(f.input.runId);
  f.manager.save({ ...previous, runId: otherId, agentId: 'another-agent' });
  await assert.rejects(
    () => f.manager.deleteAgent({ ...current, agentId: 'another-agent' }),
    /PREVIEW_IDENTITY_CHANGED/,
  );
  await f.manager.deleteAgent(current);
  assert.deepEqual([...f.manager.records.keys()], [otherId]);
  assert.equal(
    fs.existsSync(
      path.join(f.configuration.previewJournal, f.input.runId + '.json'),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(f.configuration.previewJournal, current.runId + '.json'),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(f.configuration.previewJournal, otherId + '.json')),
    true,
  );
});
