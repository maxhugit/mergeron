import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capabilities } from '../src/capabilities.mjs';
import { BrowserLifecycle } from '../src/browser-lifecycle.mjs';
import { scopeManifest } from '../src/inventory.mjs';
const base = JSON.parse(
  await readFile(new URL('../stack-manifest.json', import.meta.url)),
);
async function fixture(t, { existing = false, legacy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'capabilities-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = scopeManifest(base);
  const full = scopeManifest(base, undefined, undefined, undefined, {
    enabled: true,
  });
  const calls = [],
    networks = {},
    containers = new Map();
  const image = 'sha256:' + 'a'.repeat(64);
  const docker = {
    inspectContainer: async (name) => {
      const value =
        containers.get(name) ??
        [...containers.values()].find((c) => c.Id === name);
      if (!value) throw Object.assign(Error('missing'), { statusCode: 404 });
      return value;
    },
    inspectImage: async () => ({
      Id: image,
      RepoDigests: ['ghcr.io/maxhugit/mergeron-browser@' + image],
    }),
    pullImage: async (ref) => calls.push(['pull', ref]),
    inspectNetwork: async (name) => {
      if (!networks[name])
        throw Object.assign(Error('missing'), { statusCode: 404 });
      return networks[name];
    },
    createNetwork: async (spec) => {
      networks[spec.Name] = spec;
      calls.push(['network', spec]);
    },
    connectNetwork: async (name, id) => {
      containers.get('app').NetworkSettings.Networks[name] = {};
      calls.push(['connect', name, id]);
    },
    createContainer: async (name, spec) => {
      calls.push(['create', name, spec]);
      containers.set(name, {
        Id: 'new',
        Name: '/' + name,
        Image: image,
        Config: spec,
        HostConfig: spec.HostConfig,
        NetworkSettings: { Networks: spec.NetworkingConfig.EndpointsConfig },
        State: { Running: false },
      });
      return { Id: 'new' };
    },
    stopContainer: async (id) => {
      calls.push(['stop', id]);
      (await docker.inspectContainer(id)).State.Running = false;
    },
    removeContainer: async (id) => {
      calls.push(['remove', id]);
      for (const [name, c] of containers)
        if (c.Id === id) containers.delete(name);
    },
  };
  containers.set('app', { Id: 'app', NetworkSettings: { Networks: {} } });
  const browser = new BrowserLifecycle({ docker, manifest: full, env: {} });
  const transcription = {
    enabled: legacy,
    leases: new Map(),
    busy: false,
    prune() {},
    current: async () =>
      existing ? { Id: 'transcription', State: { Running: false } } : null,
    status: async () => ({
      state: existing ? 'stopped' : 'missing',
      activeLeases: transcription.leases.size,
    }),
    ensure: async () => calls.push(['ensure-transcription']),
  };
  const capability = new Capabilities({
    docker,
    manifest,
    browser,
    transcription,
    path: join(directory, 'capabilities.json'),
    blocked: async () => false,
    coreTrusted: async () => true,
    inventory: async () => ({
      components: [{ id: 'application', containerId: 'app' }],
    }),
    recordAdoption: async () => calls.push(['adoption']),
  });
  await capability.initialize();
  return { capability, browser, transcription, calls, containers, manifest };
}
test('fresh install has no optional containers; intent survives restart and overrides old env', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.capability.desired, {
    browser: false,
    transcription: false,
  });
  assert.equal(f.calls.length, 0);
  f.transcription.enabled = true;
  await f.capability.initialize();
  assert.equal(f.transcription.enabled, false);
  assert.equal(
    f.manifest.components.some((c) => c.id === 'browser'),
    false,
  );
});
test('migration preserves existing transcription and explicit legacy configuration', async (t) => {
  for (const options of [{ existing: true }, { legacy: true }]) {
    const f = await fixture(t, options);
    assert.equal(f.capability.desired.transcription, true);
    assert.equal(f.calls.length, 0);
  }
});
test('browser install uses reviewed isolation, no mounts/ports and dynamic application network; uninstall keeps networks/data', async (t) => {
  const f = await fixture(t);
  await f.capability.change({
    id: 'browser',
    action: 'install',
    confirmation: 'install:browser',
  });
  await f.capability.task;
  assert.equal(f.capability.error, null);
  assert.equal(f.capability.desired.browser, true);
  assert.ok(await f.browser.inspect());
  const spec = f.calls.find((c) => c[0] === 'create')[2];
  assert.equal(spec.HostConfig.Privileged, undefined);
  assert.equal(spec.HostConfig.Binds, undefined);
  assert.equal(spec.HostConfig.PortBindings, undefined);
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert.match(spec.HostConfig.SecurityOpt[1], /^seccomp=/);
  assert.equal(
    f.calls.some((c) => c[0] === 'connect'),
    true,
  );
  await f.capability.initialize();
  assert.equal(f.capability.desired.browser, true);
  await f.capability.change({
    id: 'browser',
    action: 'uninstall',
    confirmation: 'uninstall:browser',
  });
  await f.capability.task;
  assert.equal(f.capability.error, null);
  assert.equal(f.capability.desired.browser, false);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'remove'),
    [['remove', 'new']],
  );
  await f.capability.initialize();
  assert.equal(f.capability.desired.browser, false);
});
test('missing confirmation, extra Docker options, active leases and stack mutations refuse changes', async (t) => {
  const f = await fixture(t);
  const input = {
    id: 'browser',
    action: 'install',
    confirmation: 'install:browser',
  };
  await assert.rejects(
    f.capability.change({ ...input, image: 'evil' }),
    /CONFIRMATION/,
  );
  await assert.rejects(
    f.capability.change({ ...input, confirmation: '' }),
    /CONFIRMATION/,
  );
  f.browser.leases.set('lease', Date.now() + 50000);
  await assert.rejects(f.capability.change(input), /IN_USE/);
  f.browser.leases.clear();
  f.capability.blocked = async () => true;
  await assert.rejects(f.capability.change(input), /BUSY/);
  assert.equal(f.calls.length, 0);
});
test('untrusted core never triggers download or deletion', async (t) => {
  const f = await fixture(t);
  f.capability.coreTrusted = async () => false;
  await f.capability.change({
    id: 'browser',
    action: 'install',
    confirmation: 'install:browser',
  });
  await f.capability.task;
  assert.equal(f.capability.error, 'CAPABILITY_STACK_NOT_ADOPTED');
  assert.equal(f.calls.length, 0);
});

test('an in-flight lease or another operation cannot race an uninstall', async (t) => {
  const f = await fixture(t);
  const input = {
    id: 'transcription',
    action: 'install',
    confirmation: 'install:transcription',
  };
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.transcription.ensure = () =>
    new Promise((resolve) => {
      release = resolve;
      entered();
    });
  await f.capability.change(input);
  await started;
  await assert.rejects(f.capability.change(input), /BUSY/);
  release();
  await f.capability.task;
  f.transcription.leases.set('active', Date.now() + 50000);
  f.transcription.busy = true;
  await assert.rejects(
    f.capability.change({
      id: 'transcription',
      action: 'uninstall',
      confirmation: 'uninstall:transcription',
    }),
    /IN_USE/,
  );
});
test('changed companion identity after stop never gets removed', async (t) => {
  const f = await fixture(t);
  await f.capability.change({
    id: 'browser',
    action: 'install',
    confirmation: 'install:browser',
  });
  await f.capability.task;
  const item = f.containers.get('mergeron-browser');
  item.State.Running = true;
  f.capability.docker.stopContainer = async () => {
    item.State.Running = false;
    item.Id = 'foreign';
  };
  await f.capability.change({
    id: 'browser',
    action: 'uninstall',
    confirmation: 'uninstall:browser',
  });
  await f.capability.task;
  assert.equal(f.capability.error, 'CAPABILITY_CONTAINER_CHANGED');
  assert.equal(
    f.calls.some((c) => c[0] === 'remove'),
    false,
  );
});

test('migration discovers an existing browser even without its historical opt-in flag', async (t) => {
  const f = await fixture(t);
  await f.capability.change({
    id: 'browser',
    action: 'install',
    confirmation: 'install:browser',
  });
  await f.capability.task;
  await rm(f.capability.path);
  const count = f.calls.length;
  f.capability.desired.browser = false;
  f.capability.syncManifest();
  await f.capability.initialize();
  assert.equal(f.capability.desired.browser, true);
  assert.equal(
    f.manifest.components.some((c) => c.id === 'browser'),
    true,
  );
  assert.equal(f.calls.length, count);
});
test('restart keeps interrupted intent visible without rerunning a Docker mutation', async (t) => {
  const f = await fixture(t);
  f.capability.operation = { id: 'browser', action: 'install' };
  await f.capability.save();
  f.capability.operation = null;
  await f.capability.initialize();
  assert.equal(f.capability.error, 'CAPABILITY_OPERATION_INTERRUPTED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.capability.desired.browser, false);
});
test('restart grace prevents removal before active companion leases can renew', async (t) => {
  const f = await fixture(t);
  await f.capability.change({
    id: 'browser',
    action: 'install',
    confirmation: 'install:browser',
  });
  await f.capability.task;
  f.containers.get('mergeron-browser').State.Running = true;
  await f.capability.initialize();
  await assert.rejects(
    f.capability.change({
      id: 'browser',
      action: 'uninstall',
      confirmation: 'uninstall:browser',
    }),
    /IN_USE/,
  );
  assert.equal(
    f.calls.some((c) => c[0] === 'remove'),
    false,
  );
});

test('a third reviewed driver uses the same catalogue, persistent state, actions and lease guard', async (t) => {
  const { CAPABILITY_CATALOG } = await import('../src/capability-catalog.mjs');
  const f = await fixture(t);
  let installed = false;
  const entry = {
    ...CAPABILITY_CATALOG[1],
    id: 'ocr',
    driver: 'ocr',
    imageRepository: 'ghcr.io/example/ocr',
    title: { en: 'OCR', fr: 'OCR' },
    description: { en: 'Synthetic fixture', fr: 'Fixture synthétique' },
  };
  const extra = new Capabilities({
    ...f.capability,
    catalogue: [...CAPABILITY_CATALOG, entry],
    drivers: {
      ...Object.fromEntries(
        f.capability.registry.map((e) => [e.driver, e.lifecycle]),
      ),
      ocr: {
        inspect: async () =>
          installed ? { Id: 'ocr-owned', State: { Running: false } } : null,
        status: async () => ({ state: installed ? 'stopped' : 'missing' }),
        install: async () => {
          installed = true;
        },
        configure: () => {},
        prune: () => {},
        busy: () => false,
        activeLeases: () => 0,
        legacyEnabled: () => false,
      },
    },
  });
  await extra.initialize();
  assert.equal(extra.desired.ocr, false); // Added to an existing installation, not auto-installed.
  const before = (await extra.status()).capabilities.find(
    (c) => c.id === 'ocr',
  );
  assert.equal(before.state, 'notInstalled');
  assert.equal(before.title.en, 'OCR');
  await extra.change({
    id: 'ocr',
    action: 'install',
    confirmation: 'install:ocr',
  });
  await extra.task;
  assert.equal(extra.error, null);
  assert.equal(extra.desired.ocr, true);
  assert.equal(
    (await extra.status()).capabilities.find((c) => c.id === 'ocr').state,
    'stopped',
  );
  assert.equal(
    JSON.stringify(await extra.status()).includes('lifecycle'),
    false,
  );
});
test('catalogue refuses unsafe defaults, duplicate ids and missing reviewed lifecycle adapters', async () => {
  const { CAPABILITY_CATALOG, capabilityRegistry } =
    await import('../src/capability-catalog.mjs');
  assert.throws(
    () =>
      capabilityRegistry(
        [{ ...CAPABILITY_CATALOG[0], defaultInstalled: true }],
        {},
      ),
    /CATALOG_INVALID/,
  );
  assert.throws(
    () => capabilityRegistry(CAPABILITY_CATALOG, {}),
    /CATALOG_INVALID/,
  );
});
