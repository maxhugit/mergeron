import assert from 'node:assert/strict';
import test from 'node:test';
import { collectInventory, scopeManifest } from '../src/inventory.mjs';
import {
  installedImageBuild,
  inspectInstalledBuild,
  inspectManagerBuild,
} from '../src/installed-build.mjs';

const id = `sha256:${'a'.repeat(64)}`;
const revision = 'b'.repeat(40);
const image = {
  Id: id,
  Config: {
    Labels: {
      'org.opencontainers.image.version': '0.5.1',
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.created': '2026-10-31T12:00:00Z',
      'io.mergeron.channel': 'edge',
      secret: 'never-export-this-label',
    },
  },
};

test('reads installed build from the immutable image, never a moving tag or stale container labels', async () => {
  const calls = [];
  const docker = {
    inspectImage: async (reference) => {
      calls.push(reference);
      return image;
    },
  };
  const build = await inspectInstalledBuild(
    docker,
    {
      Image: id,
      Config: {
        Image: 'ghcr.io/maxhugit/mergeron:edge',
        Labels: { 'org.opencontainers.image.revision': 'c'.repeat(40) },
      },
    },
    'application',
  );
  assert.deepEqual(calls, [id]);
  assert.deepEqual(build, {
    version: '0.5.1',
    revision,
    builtAt: '2026-10-31T12:00:00.000Z',
    channel: 'edge',
  });
  assert.ok(!JSON.stringify(build).includes('never-export'));
});

test('old browser Ubuntu labels never become a Mergeron version; explicit product metadata works', () => {
  const browser = structuredClone(image);
  browser.Config.Labels['org.opencontainers.image.version'] = '24.04';
  delete browser.Config.Labels['io.mergeron.channel'];
  assert.equal(installedImageBuild(browser, 'browser').version, null);
  assert.equal(installedImageBuild(browser, 'browser').revision, revision);
  assert.equal(installedImageBuild(browser, 'browser').channel, 'unknown');
  assert.equal(installedImageBuild(browser, 'browser').builtAt, null);
  browser.Config.Labels['io.mergeron.version'] = '0.5.1';
  assert.equal(installedImageBuild(browser, 'browser').version, '0.5.1');
});

test('invalid or missing metadata is unknown and cannot fail healthy inventory', async () => {
  assert.deepEqual(
    installedImageBuild(
      {
        Config: {
          Labels: {
            'org.opencontainers.image.version': 'secret\n'.repeat(20),
            'org.opencontainers.image.revision': [revision],
            'org.opencontainers.image.created': 'not-a-date',
            'io.mergeron.channel': 'latest',
          },
        },
      },
      'application',
    ),
    { version: null, revision: null, builtAt: null, channel: 'unknown' },
  );
  assert.equal(
    await inspectInstalledBuild(
      {
        inspectImage: async () => {
          throw new Error('private daemon details');
        },
      },
      { Image: id },
      'application',
    ),
    null,
  );
  assert.equal(
    await inspectInstalledBuild(
      {
        inspectImage: async () => ({
          ...image,
          Id: 'sha256:' + 'f'.repeat(64),
        }),
      },
      { Image: id },
      'application',
    ),
    null,
  );
});

test('Manager identity is read-only, stack scoped and separate from update components', async () => {
  const manifest = {
    stack: 'mergeron-dev',
    schemaVersion: 1,
    environment: 'development',
    components: [],
  };
  const docker = {
    listContainers: async () => [
      { Id: 'prod', Names: ['/mergeron-manager'] },
      { Id: 'dev', Names: ['/mergeron-dev-manager'] },
    ],
    inspectContainer: async (container) => {
      assert.equal(container, 'dev');
      return { Image: id };
    },
    inspectImage: async () => image,
  };
  const inventory = await collectInventory(manifest, docker);
  assert.equal(inventory.manager.build.revision, revision);
  assert.equal(inventory.manager.imageId, id);
  assert.deepEqual(inventory.components, []);
  assert.equal(
    await inspectManagerBuild(
      manifest,
      [
        { Names: ['/mergeron-dev-manager'] },
        { Names: ['/mergeron-dev-manager'] },
      ],
      docker,
    ),
    null,
  );
  assert.equal(await inspectManagerBuild(manifest, [], docker), null);
});

test('component inventory exposes only build metadata from its actual image', async () => {
  const manifest = scopeManifest({
    stack: 'mergeron',
    schemaVersion: 1,
    networks: [],
    components: [
      {
        id: 'application',
        canonicalName: 'mergeron-ui',
        allowedImageRepositories: ['ghcr.io/maxhugit/mergeron'],
        requiredNetworks: [],
        protectedMounts: [],
      },
    ],
  });
  const inventory = await collectInventory(manifest, {
    listContainers: async () => [{ Id: 'app', Names: ['/mergeron-ui'] }],
    inspectContainer: async () => ({
      Image: id,
      Config: {
        Image: 'ghcr.io/maxhugit/mergeron:edge',
        Labels: { 'org.opencontainers.image.revision': 'c'.repeat(40) },
      },
      State: { Running: true },
      NetworkSettings: {},
    }),
    inspectImage: async () => image,
  });
  assert.equal(inventory.components[0].build.revision, revision);
  assert.equal(inventory.components[0].state, 'running');
  assert.ok(!JSON.stringify(inventory).includes('never-export'));
});
