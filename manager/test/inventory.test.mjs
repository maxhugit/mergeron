import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { collectInventory, scopeManifest } from '../src/inventory.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../stack-manifest.json', import.meta.url), 'utf8'),
);

test('scopes the external proxy network independently of the private stack', () => {
  for (const network of ['shared-proxy', 'net_standard', 'caddy.default']) {
    const scoped = scopeManifest(
      manifest,
      'mergeron-dev',
      'development',
      network,
    );
    assert.equal(
      scoped.networks.find((item) => item.id === 'proxy').name,
      network,
    );
    assert.deepEqual(
      scoped.components.find((item) => item.id === 'ingress').requiredNetworks,
      ['mergeron-dev-isolated', network],
    );
    assert.equal(
      scoped.networks.find((item) => item.id === 'proxy').external,
      true,
    );
    assert.equal(
      manifest.networks.find((item) => item.id === 'proxy').name,
      'mergeron-proxy',
    );
  }
});

test('rejects invalid or private-network-colliding proxy names', () => {
  for (const network of [
    '',
    'bad network',
    '../host',
    'host',
    'bridge',
    'none',
    'mergeron-dev-isolated',
    'mergeron-dev-admin',
    'mergeron-dev-external',
  ]) {
    assert.throws(
      () => scopeManifest(manifest, 'mergeron-dev', 'development', network),
      /MERGERON_PROXY_NETWORK/,
    );
  }
});

test('exposes configuration metadata without arbitrary environment values', async () => {
  const docker = fixtureDocker();
  const inspect = docker.inspectContainer.bind(docker);
  docker.inspectContainer = async (id) => {
    const result = await inspect(id);
    return {
      ...result,
      Config: {
        ...result.Config,
        Env: [
          'NODE_ENV=production',
          'JWT_SECRET=test-secret-never-expose',
          'CUSTOM_URL=https://user:password@example.invalid',
        ],
      },
      HostConfig: {
        NetworkMode: 'bridge',
        RestartPolicy: { Name: 'unless-stopped' },
      },
    };
  };
  const result = await collectInventory(manifest, docker);
  const configuration = result.components[0].configuration;
  assert.equal(configuration.networkMode, 'bridge');
  assert.deepEqual(configuration.environment, [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'JWT_SECRET', value: null },
    { name: 'CUSTOM_URL', value: null },
  ]);
  assert.ok(!JSON.stringify(result).includes('test-secret-never-expose'));
  assert.ok(!JSON.stringify(result).includes('user:password'));
});

function fixtureDocker({ missingWorkspace = false, duplicate = false } = {}) {
  const containers = [
    {
      Id: 'application-id-123456789',
      Names: ['/codex-webui'],
      Image: 'ghcr.io/maxhugit/mergeron:latest',
      Labels: {},
    },
    {
      Id: 'ingress-id-123456789',
      Names: ['/mergeron-ingress'],
      Image: 'nginx:stable',
      Labels: {
        'io.mergeron.managed': 'true',
        'io.mergeron.component': 'ingress',
      },
    },
    {
      Id: 'egress-id-123456789',
      Names: ['/mergeron-squid'],
      Image: 'ubuntu/squid:latest',
      Labels: {},
    },
  ];
  if (duplicate)
    containers.push({
      Id: 'application-duplicate',
      Names: ['/mergeron-ui'],
      Image: 'ghcr.io/maxhugit/mergeron:latest',
      Labels: {},
    });
  const inspections = Object.fromEntries(
    containers.map((container) => [
      container.Id,
      {
        Name: container.Names[0],
        Config: { Image: container.Image, Labels: container.Labels },
        State: {
          Running: true,
          Status: 'running',
          Health: { Status: 'healthy' },
        },
        RestartCount: 0,
        NetworkSettings: {
          Networks: container.Id.startsWith('application')
            ? { 'mergeron-isolated': {}, 'mergeron-admin': {} }
            : container.Id.startsWith('ingress')
              ? { 'mergeron-isolated': {}, 'mergeron-proxy': {} }
              : { 'mergeron-isolated': {}, 'mergeron-external': {} },
        },
        Mounts: container.Id.startsWith('application')
          ? [
              {
                Source: '/srv/mergeron/state/home',
                Destination: '/home/codex',
                Type: 'bind',
                RW: true,
              },
              ...(!missingWorkspace
                ? [
                    {
                      Source: '/srv/mergeron/state/workspace',
                      Destination: '/workspaces',
                      Type: 'bind',
                      RW: true,
                    },
                  ]
                : []),
            ]
          : [],
      },
    ]),
  );
  return {
    listContainers: async () => containers,
    inspectContainer: async (id) => inspections[id],
  };
}

test('adopts legacy names without mutating them and protects existing data mounts', async () => {
  const status = await collectInventory(
    manifest,
    fixtureDocker(),
    new Date('2026-10-24T07:00:00Z'),
  );
  assert.equal(status.mode, 'observe');
  assert.equal(status.dataSafety.status, 'protected');
  assert.deepEqual(
    status.components.map(({ id, adoption, state }) => ({
      id,
      adoption,
      state,
    })),
    [
      { id: 'application', adoption: 'adoptable', state: 'healthy' },
      { id: 'ingress', adoption: 'managed', state: 'healthy' },
      { id: 'egress', adoption: 'adoptable', state: 'healthy' },
    ],
  );
});

test('blocks future management if a persistent workspace mount is missing', async () => {
  const status = await collectInventory(
    manifest,
    fixtureDocker({ missingWorkspace: true }),
  );
  assert.equal(status.dataSafety.status, 'blocked');
  assert.deepEqual(status.dataSafety.blockers, [
    'application:/workspaces:unprotected',
  ]);
});

test('refuses to choose between duplicate application containers', async () => {
  const status = await collectInventory(
    manifest,
    fixtureDocker({ duplicate: true }),
  );
  assert.equal(status.components[0].state, 'conflict');
  assert.equal(status.dataSafety.status, 'blocked');
  assert.ok(
    status.dataSafety.blockers.includes('application:multipleContainers'),
  );
});

test('scopes names and private networks for an isolated development stack', () => {
  const scoped = scopeManifest(manifest, 'mergeron-dev', 'development');
  assert.equal(scoped.stack, 'mergeron-dev');
  assert.equal(scoped.environment, 'development');
  assert.deepEqual(
    scoped.components.map((component) => component.canonicalName),
    ['mergeron-dev-ui', 'mergeron-dev-ingress', 'mergeron-dev-squid'],
  );
  assert.deepEqual(scoped.components[0].legacyNames, []);
  assert.deepEqual(scoped.components[0].requiredNetworks, [
    'mergeron-dev-isolated',
    'mergeron-dev-admin',
  ]);
  assert.deepEqual(scoped.components[1].requiredNetworks, [
    'mergeron-dev-isolated',
    'mergeron-proxy',
  ]);
});

test('rejects an unsafe stack prefix', () => {
  assert.throws(() => scopeManifest(manifest, '../production'));
});

test('rejects an invalid environment or a development production identity', () => {
  assert.throws(
    () => scopeManifest(manifest, 'mergeron-dev', 'staging'),
    /MERGERON_STACK_ENVIRONMENT/,
  );
  assert.throws(
    () => scopeManifest(manifest, 'mergeron', 'development'),
    /dedicated MERGERON_STACK_PREFIX/,
  );
});

test('does not select labeled production containers from a development stack', async () => {
  const productionContainer = {
    Id: 'production-application',
    Names: ['/unrelated-name'],
    Image: 'ghcr.io/maxhugit/mergeron:latest',
    Labels: {
      'io.mergeron.managed': 'true',
      'io.mergeron.stack': 'mergeron',
      'io.mergeron.component': 'application',
    },
  };
  const status = await collectInventory(
    scopeManifest(manifest, 'mergeron-dev', 'development'),
    {
      listContainers: async () => [productionContainer],
      inspectContainer: async () => {
        throw new Error('production container must not be inspected');
      },
    },
  );
  assert.equal(status.components[0].state, 'missing');
});

test('includes the installed stopped Byparr in inventory, without waking it or exposing environment values', async () => {
  const scoped = scopeManifest(manifest);
  const base = fixtureDocker();
  const imageId = 'sha256:' + 'd'.repeat(64);
  const labels = {
    'io.mergeron.managed': 'true',
    'io.mergeron.component': 'appCatalog',
    'io.mergeron.stack': 'mergeron',
  };
  const entries = await base.listContainers();
  const docker = {
    ...base,
    listContainers: async () => [
      ...entries,
      { Id: 'byparr', Names: ['/mergeron-byparr'], Labels: labels },
    ],
    inspectContainer: async (id) =>
      id === 'byparr'
        ? {
            Id: id,
            Name: '/mergeron-byparr',
            Image: imageId,
            Config: {
              Image: 'ghcr.io/thephaseless/byparr:latest',
              Labels: labels,
              Env: ['VERSION=2.2.0', 'SECRET=never-expose'],
            },
            State: { Running: false, Status: 'exited' },
            NetworkSettings: { Networks: { 'mergeron-isolated': {} } },
            Mounts: [],
            HostConfig: {},
          }
        : base.inspectContainer(id),
    inspectImage: async () => ({
      Id: imageId,
      Config: { Env: ['VERSION=v2.2.0'] },
    }),
  };
  const result = await collectInventory(scoped, docker);
  const byparr = result.components.find((c) => c.id === 'appCatalog');
  assert.equal(byparr.state, 'stopped');
  assert.equal(byparr.build.version, '2.2.0');
  assert.equal(byparr.observational, true);
  assert.equal(byparr.adoption, 'managed');
  assert.ok(!JSON.stringify(result).includes('never-expose'));
});

test('discovers arbitrary managed stack containers and keeps replicas distinct without granting management', async () => {
  const { inventoryFingerprint } = await import('../src/adoption.mjs');
  const base = fixtureDocker();
  const before = await collectInventory(manifest, base);
  const labels = (role) => ({
    'io.mergeron.managed': 'true',
    'io.mergeron.component': role,
    'io.mergeron.stack': manifest.stack,
  });
  const extras = [
    {
      Id: 'relay-one',
      Names: ['/mergeron-acces-web-1'],
      Labels: labels('updateGateway'),
    },
    {
      Id: 'relay-two',
      Names: ['/mergeron-acces-web-2'],
      Labels: labels('updateGateway'),
    },
    {
      Id: 'new-service',
      Names: ['/mergeron-future-worker'],
      Labels: labels('futureWorker'),
    },
    {
      Id: 'foreign',
      Names: ['/mergeron-foreign'],
      Labels: { ...labels('worker'), 'io.mergeron.stack': 'another-stack' },
    },
    {
      Id: 'unmanaged',
      Names: ['/mergeron-unmanaged'],
      Labels: { ...labels('worker'), 'io.mergeron.managed': 'false' },
    },
    { Id: 'changed', Names: ['/mergeron-changed'], Labels: labels('worker') },
  ];
  const result = await collectInventory(manifest, {
    ...base,
    listContainers: async () => [...(await base.listContainers()), ...extras],
    inspectContainer: async (id) => {
      const c = extras.find((c) => c.Id === id);
      if (!c) return base.inspectContainer(id);
      if (id === 'foreign' || id === 'unmanaged')
        throw Error('must not inspect unrelated containers');
      return {
        Id: id,
        Name: c.Names[0],
        Config: {
          Image: 'registry.example/worker:1',
          Labels:
            id === 'changed'
              ? { ...c.Labels, 'io.mergeron.stack': 'another-stack' }
              : c.Labels,
          Env: ['TOKEN=private'],
        },
        State: { Running: true, Health: { Status: 'healthy' } },
        NetworkSettings: { Networks: {} },
        HostConfig: {},
        Mounts: [],
      };
    },
  });
  const extra = result.components.filter((c) => c.discovered);
  assert.equal(extra.length, 3);
  assert.equal(new Set(extra.map((c) => c.id)).size, 3);
  assert.ok(
    extra.every(
      (c) =>
        c.observational &&
        c.state === 'healthy' &&
        c.imageRepositoryAllowed === null,
    ),
  );
  assert.equal(extra.filter((c) => c.role === 'updateGateway').length, 2);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(inventoryFingerprint(result), inventoryFingerprint(before));
  assert.deepEqual(result.dataSafety, before.dataSafety);
});
