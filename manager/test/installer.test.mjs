import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyInstallPlan,
  containerSpecification,
  createInstallPlan,
  readInstallConfiguration,
} from '../src/installer.mjs';
import { scopeManifest } from '../src/inventory.mjs';

const sourceManifest = JSON.parse(
  await readFile(new URL('../stack-manifest.json', import.meta.url), 'utf8'),
);
const manifest = scopeManifest(sourceManifest, 'mergeron', 'production');

test('selects icons from the declared environment and preserves custom overrides', () => {
  const dev = scopeManifest(sourceManifest, 'mergeron-dev', 'development');
  const production = readInstallConfiguration(manifest, {});
  const development = readInstallConfiguration(dev, {
    MERGERON_HOST_INTEGRATION: 'unraid',
  });
  assert.match(production.iconUrl, /\/pwa-icon-192\.png$/);
  assert.match(development.iconUrl, /\/pwa-dev-icon-192\.png$/);
  assert.equal(
    readInstallConfiguration(dev, { MERGERON_ICON_URL: '' }).iconUrl,
    development.iconUrl,
  );
  assert.equal(
    readInstallConfiguration(dev, {
      MERGERON_ICON_URL: 'https://example.test/custom.png',
    }).iconUrl,
    'https://example.test/custom.png',
  );
  const app = containerSpecification(
    dev,
    dev.components.find((c) => c.id === 'application'),
    development,
  );
  assert.equal(app.Labels['net.unraid.docker.icon'], development.iconUrl);
  assert.ok(app.Env.includes('MERGERON_STACK_ENVIRONMENT=development'));
});

class FixtureDocker {
  constructor({ proxy = true } = {}) {
    this.networks = proxy
      ? [{ Name: 'mergeron-proxy', Driver: 'bridge', Internal: false }]
      : [];
    this.containers = [];
    this.images = [];
    this.inspections = new Map();
    this.calls = [];
  }

  async listNetworks() {
    return this.networks;
  }

  async listContainers() {
    return this.containers;
  }

  async listImages() {
    return this.images;
  }

  async inspectContainer(id) {
    return this.inspections.get(id);
  }

  async createNetwork(specification) {
    this.calls.push(['createNetwork', specification.Name]);
    this.networks.push({
      ...specification,
      Name: specification.Name,
      IPAM: specification.IPAM ?? { Config: [] },
    });
    return { Id: `network-${specification.Name}` };
  }

  async pullImage(reference) {
    this.calls.push(['pullImage', reference]);
    this.images.push({ RepoTags: [reference], RepoDigests: [] });
  }

  async createContainer(name, specification) {
    this.calls.push(['createContainer', name]);
    const id = `container-${name}`;
    this.containers.push({
      Id: id,
      Names: [`/${name}`],
      Image: specification.Image,
      Labels: specification.Labels,
    });
    this.inspections.set(id, {
      Name: `/${name}`,
      Config: {
        Image: specification.Image,
        Labels: specification.Labels,
      },
      State: { Running: false, Status: 'created' },
      RestartCount: 0,
      NetworkSettings: {
        Networks: specification.NetworkingConfig.EndpointsConfig,
      },
      Mounts: (specification.HostConfig.Binds ?? []).map((bind) => {
        const [Source, Destination, mode] = bind.split(':');
        return { Source, Destination, Type: 'bind', RW: mode !== 'ro' };
      }),
    });
    return { Id: id };
  }

  async startContainer(id) {
    this.calls.push(['startContainer', id]);
    const inspection = this.inspections.get(id);
    inspection.State = { Running: true, Status: 'running' };
  }
}

async function fixtureConfiguration(directory) {
  const defaults = join(directory, 'defaults');
  await mkdir(defaults);
  await Promise.all([
    writeFile(join(defaults, 'nginx.conf.template'), 'existing nginx default'),
    writeFile(
      join(defaults, 'nginx.native.conf.template'),
      'native upstream http://mergeron-ui:8172',
    ),
    writeFile(join(defaults, 'squid.conf'), 'existing squid default'),
  ]);
  const configuration = readInstallConfiguration(manifest, {
    MERGERON_STATE_ROOT: '/srv/mergeron/state',
    MERGERON_MANAGER_HOST_STATE: directory,
    MERGERON_MANAGER_DEFAULT_CONFIG: defaults,
    MERGERON_WEBUI_URL: 'https://mergeron.example.test',
  });
  configuration.applyOwnership = false;
  return configuration;
}

test('plans only missing declared resources and exposes zero destructive actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-install-'));
  try {
    const plan = await createInstallPlan(
      manifest,
      new FixtureDocker(),
      await fixtureConfiguration(directory),
      new Date('2026-10-24T11:00:00Z'),
    );
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.destructiveActions, []);
    assert.equal(
      plan.actions.filter((action) => action.type === 'createNetwork').length,
      3,
    );
    assert.equal(
      plan.actions.filter((action) => action.type === 'createContainer').length,
      3,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new installations default to native sessions/OIDC without imposing an identity vendor', () => {
  assert.equal(readInstallConfiguration(manifest, {}).authMode, 'native');
  assert.equal(
    readInstallConfiguration(manifest, { MERGERON_AUTH_MODE: 'authentik' })
      .authMode,
    'authentik',
  );
});

test('blocks installation when the external proxy network is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-install-'));
  try {
    const plan = await createInstallPlan(
      manifest,
      new FixtureDocker({ proxy: false }),
      await fixtureConfiguration(directory),
    );
    assert.equal(plan.applicable, false);
    assert.ok(plan.blockers.includes('mergeron-proxy:externalNetworkMissing'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses portable defaults and accepts the legacy appdata variable', () => {
  const configuration = readInstallConfiguration(manifest, {});
  assert.equal(configuration.stateRoot, '/srv/mergeron/state');
  assert.equal(configuration.appdataRoot, '/srv/mergeron/state/appdata');
  assert.equal(configuration.hostIntegration, 'none');
  const specification = containerSpecification(
    manifest,
    manifest.components[0],
    configuration,
  );
  assert.equal(
    Object.keys(specification.Labels).some((name) => name.startsWith('net.')),
    false,
  );
  assert.equal(
    readInstallConfiguration(manifest, {
      MERGERON_UNRAID_APPDATA_ROOT: '/legacy/appdata',
    }).appdataRoot,
    '/legacy/appdata',
  );
  assert.equal(
    readInstallConfiguration(manifest, {
      MERGERON_UNRAID_APPDATA_ROOT: '/legacy/appdata',
      MERGERON_APPDATA_ROOT: '/data/apps',
    }).appdataRoot,
    '/data/apps',
  );
  assert.throws(
    () =>
      readInstallConfiguration(manifest, { MERGERON_AUTH_MODE: 'anonymous' }),
    /MERGERON_AUTH_MODE/,
  );
});

test('installs with a custom proxy network and native auth without managing the external network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-portable-'));
  try {
    const scoped = scopeManifest(
      sourceManifest,
      'portable',
      'production',
      'caddy-proxy',
    );
    const configuration = await fixtureConfiguration(directory);
    configuration.stackPrefix = 'portable';
    configuration.authMode = 'native';
    const docker = new FixtureDocker({ proxy: false });
    docker.networks.push({
      Name: 'caddy-proxy',
      Driver: 'bridge',
      Internal: false,
    });
    const plan = await createInstallPlan(scoped, docker, configuration);
    assert.equal(plan.applicable, true);
    await applyInstallPlan({
      manifest: scoped,
      docker,
      configuration,
      expectedFingerprint: plan.fingerprint,
      confirmation: 'INSTALL',
    });
    assert.equal(
      await readFile(join(directory, 'config/nginx.conf.template'), 'utf8'),
      'native upstream http://portable-ui:8172',
    );
    assert.deepEqual(
      docker.calls
        .filter(([operation]) => operation === 'createNetwork')
        .map(([, name]) => name)
        .sort(),
      ['portable-admin', 'portable-external', 'portable-isolated'],
    );
    assert.deepEqual(
      Object.keys(
        docker.inspections.get('container-portable-ingress').NetworkSettings
          .Networks,
      ).sort(),
      ['caddy-proxy', 'portable-isolated'],
    );
    configuration.authMode = 'authentik';
    const second = await createInstallPlan(scoped, docker, configuration);
    await applyInstallPlan({
      manifest: scoped,
      docker,
      configuration,
      expectedFingerprint: second.fingerprint,
      confirmation: 'INSTALL',
    });
    assert.equal(
      await readFile(join(directory, 'config/nginx.conf.template'), 'utf8'),
      'native upstream http://portable-ui:8172',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses a stale or unconfirmed plan before the first Docker write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-install-'));
  try {
    const configuration = await fixtureConfiguration(directory);
    const docker = new FixtureDocker();
    const plan = await createInstallPlan(manifest, docker, configuration);
    await assert.rejects(
      applyInstallPlan({
        manifest,
        docker,
        configuration,
        expectedFingerprint: plan.fingerprint,
        confirmation: 'WRONG',
      }),
      /installationConfirmationRequired/,
    );
    await assert.rejects(
      applyInstallPlan({
        manifest,
        docker,
        configuration,
        expectedFingerprint: 'stale',
        confirmation: 'INSTALL',
      }),
      /installationPlanChanged/,
    );
    assert.deepEqual(docker.calls, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('applies a fresh installation once and preserves every existing file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-install-'));
  try {
    const configuration = await fixtureConfiguration(directory);
    await mkdir(join(directory, 'home'));
    await mkdir(join(directory, 'config'));
    await writeFile(join(directory, 'home', 'keep.txt'), 'do not replace');
    await writeFile(join(directory, 'config', 'squid.conf'), 'custom squid');
    const docker = new FixtureDocker();
    const plan = await createInstallPlan(manifest, docker, configuration);
    const result = await applyInstallPlan({
      manifest,
      docker,
      configuration,
      expectedFingerprint: plan.fingerprint,
      confirmation: 'INSTALL',
    });
    assert.equal(result.changed, true);
    assert.deepEqual(
      docker.calls.filter(([operation]) => operation === 'createContainer'),
      [
        ['createContainer', 'mergeron-squid'],
        ['createContainer', 'mergeron-ui'],
        ['createContainer', 'mergeron-ingress'],
      ],
    );
    assert.equal(
      await readFile(join(directory, 'home', 'keep.txt'), 'utf8'),
      'do not replace',
    );
    assert.equal(
      await readFile(join(directory, 'config', 'squid.conf'), 'utf8'),
      'custom squid',
    );
    const secondPlan = await createInstallPlan(manifest, docker, configuration);
    assert.equal(secondPlan.applicable, true);
    assert.deepEqual(secondPlan.actions, []);
    const second = await applyInstallPlan({
      manifest,
      docker,
      configuration,
      expectedFingerprint: secondPlan.fingerprint,
      confirmation: 'INSTALL',
    });
    assert.equal(second.changed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unsafe paths, environments and image repositories', () => {
  assert.throws(
    () => readInstallConfiguration(manifest, { MERGERON_STATE_ROOT: '/' }),
    /MERGERON_STATE_ROOT/,
  );
  assert.throws(
    () =>
      readInstallConfiguration(manifest, {
        MERGERON_APP_IMAGE: 'docker.io/untrusted/application:latest',
      }),
    /imageRepositoryNotAllowed/,
  );
  assert.throws(
    () =>
      readInstallConfiguration(manifest, {
        MERGERON_ADMIN_SUBNET: '172.999.44.0/28',
      }),
    /MERGERON_ADMIN_SUBNET/,
  );
});

test('uses isolated development names and runtime configuration', async () => {
  const development = scopeManifest(
    sourceManifest,
    'mergeron-dev',
    'development',
  );
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-install-'));
  try {
    const configuration = readInstallConfiguration(development, {
      MERGERON_STATE_ROOT: '/srv/mergeron-dev/state',
      MERGERON_MANAGER_HOST_STATE: directory,
    });
    const component = development.components.find(
      (item) => item.id === 'application',
    );
    const specification = containerSpecification(
      development,
      component,
      configuration,
    );
    assert.ok(specification.Env.includes('NODE_ENV=development'));
    assert.deepEqual(
      Object.keys(specification.NetworkingConfig.EndpointsConfig).sort(),
      ['mergeron-dev-admin', 'mergeron-dev-isolated'],
    );
    assert.equal(specification.Image, 'ghcr.io/maxhugit/mergeron:edge');
    assert.deepEqual(specification.HostConfig.SecurityOpt, [
      'no-new-privileges:true',
    ]);
    assert.deepEqual(specification.HostConfig.MaskedPaths, []);
    assert.deepEqual(specification.HostConfig.ReadonlyPaths, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
for (const authMode of ['native', 'authentik'])
  test(`creates development nginx upstreams without changing existing configuration (${authMode})`, async () => {
    const development = scopeManifest(
      sourceManifest,
      'mergeron-dev',
      'development',
    );
    const directory = await mkdtemp(join(tmpdir(), 'mergeron-install-'));
    try {
      const configuration = await fixtureConfiguration(directory);
      configuration.stackPrefix = development.stack;
      configuration.authMode = authMode;
      const template =
        authMode === 'native'
          ? 'nginx.native.conf.template'
          : 'nginx.conf.template';
      await writeFile(
        join(configuration.defaultsPath, template),
        await readFile(
          new URL(`../../deployment/config/${template}`, import.meta.url),
          'utf8',
        ),
      );
      const docker = new FixtureDocker();
      const plan = await createInstallPlan(development, docker, configuration);
      await applyInstallPlan({
        manifest: development,
        docker,
        configuration,
        expectedFingerprint: plan.fingerprint,
        confirmation: 'INSTALL',
      });
      const generated = await readFile(
        join(directory, 'config/nginx.conf.template'),
        'utf8',
      );
      assert.ok(generated.includes('http://mergeron-dev-ui:8172'));
      assert.ok(generated.includes('http://mergeron-dev-ui:12345'));
      assert.ok(!generated.includes('http://mergeron-ui:'));
      const second = await createInstallPlan(
        development,
        docker,
        configuration,
      );
      assert.deepEqual(second.actions, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
