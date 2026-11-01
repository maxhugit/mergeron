import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageUpdates } from '../src/image-updates.mjs';

const old = `sha256:${'a'.repeat(64)}`;
const next = `sha256:${'b'.repeat(64)}`;
function fixture() {
  const calls = [];
  const repos = {
    application: 'ghcr.io/maxhugit/mergeron',
    ingress: 'nginx',
    egress: 'ubuntu/squid',
    browser: 'ghcr.io/maxhugit/mergeron-browser',
  };
  const components = Object.entries(repos).map(([id, repo]) => ({
    id,
    displayName: id,
    allowedImageRepositories: [repo],
  }));
  const docker = {
    inspectContainer: async (id) => ({
      Image: id,
      Config: { Image: `${repos[id]}@${old}` },
    }),
    inspectImage: async (id) => ({
      Id: old,
      RepoDigests: [`${repos[id]}@${old}`],
      Os: 'linux',
      Architecture: 'amd64',
    }),
    inspectDistribution: async (ref) => {
      calls.push(ref);
      return {
        Descriptor: { digest: next },
        Platforms: [{ os: 'linux', architecture: 'amd64' }],
      };
    },
  };
  const options = {
    docker,
    manifest: { environment: 'development', components },
    configuration: { images: {} },
    inventory: async () => ({
      components: components.map((c) => ({
        ...c,
        containerId: c.id,
        adoption: 'managed',
        image: `${repos[c.id]}@${old}`,
      })),
    }),
  };
  return { service: new ImageUpdates(options), options, docker, calls };
}
test('discovers all four components read-only but never calls an index change an update', async () => {
  const { service, calls } = fixture();
  const result = await service.status();
  assert.equal(result.components.length, 4);
  assert.ok(
    result.components.every(
      (c) =>
        !c.updateAvailable &&
        c.platformCheckRequired &&
        c.versionStatus === 'unknown' &&
        c.targetDigest === next &&
        c.installedImageId === old &&
        c.platform.architecture === 'amd64',
    ),
  );
  assert.deepEqual(
    calls.sort(),
    [
      'ghcr.io/maxhugit/mergeron:edge',
      'nginx:stable',
      'ubuntu/squid:latest',
      'ghcr.io/maxhugit/mergeron-browser:edge',
    ].sort(),
  );
  await service.status();
  assert.equal(calls.length, 4);
  await service.status(true);
  assert.equal(calls.length, 8);
});
test('deduplicates simultaneous refreshes', async () => {
  const { service, calls } = fixture();
  await Promise.all([service.status(true), service.status(true)]);
  assert.equal(calls.length, 4);
});

test('discovers the Manager separately without making it a managed update target', async () => {
  const { service, docker, options, calls } = fixture();
  service.manifest.stack = 'mergeron-dev';
  const inventory = options.inventory;
  service.inventory = async () => ({
    ...(await inventory()),
    manager: { imageId: old },
  });
  docker.listContainers = async () => [
    { Id: 'manager', Names: ['/mergeron-dev-manager'] },
  ];
  const inspect = docker.inspectContainer;
  docker.inspectContainer = async (id) =>
    id === 'manager'
      ? {
          Image: 'manager',
          Config: { Image: `ghcr.io/maxhugit/mergeron-manager@${old}` },
        }
      : inspect(id);
  const image = docker.inspectImage;
  docker.inspectImage = async (id) =>
    id === 'manager'
      ? {
          Id: old,
          RepoDigests: [`ghcr.io/maxhugit/mergeron-manager@${old}`],
          Os: 'linux',
          Architecture: 'amd64',
        }
      : image(id);
  const result = await service.status();
  assert.equal(result.components.length, 5);
  assert.ok(calls.includes('ghcr.io/maxhugit/mergeron-manager:edge'));
  assert.ok(!options.manifest.components.some((item) => item.id === 'manager'));
});
test('keeps installed metadata separate from the registry target and stale container labels', async () => {
  const { service, docker } = fixture();
  docker.inspectContainer = async () => ({
    Image: old,
    Config: { Labels: { 'org.opencontainers.image.revision': 'c'.repeat(40) } },
  });
  docker.inspectImage = async () => ({
    Id: old,
    RepoDigests: [`ghcr.io/maxhugit/mergeron@${old}`],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      Labels: {
        'org.opencontainers.image.version': '0.5.1',
        'org.opencontainers.image.revision': 'd'.repeat(40),
      },
    },
  });
  const result = (await service.status()).components[0];
  assert.equal(result.installedBuild.revision, 'd'.repeat(40));
  assert.equal(result.installedBuild.version, '0.5.1');
  assert.equal(result.installedBuild.channel, 'unknown');
  assert.equal(result.targetImage, 'ghcr.io/maxhugit/mergeron:edge');
  assert.equal(result.targetDigest, next);
});
test('does not declare a current container outdated', async () => {
  const { service, docker } = fixture();
  docker.inspectDistribution = async () => ({
    Descriptor: { digest: old },
    Platforms: [{ os: 'linux', architecture: 'amd64' }],
  });
  assert.ok(
    (await service.status()).components.every(
      (c) => !c.updateAvailable && c.versionStatus === 'current',
    ),
  );
});
test('an unavailable registry is unknown, never current, and does not fail other checks', async () => {
  const { service, docker } = fixture();
  const original = docker.inspectDistribution;
  docker.inspectDistribution = async (ref) => {
    if (ref.startsWith('nginx:')) throw new Error('secret registry error');
    return original(ref);
  };
  const result = await service.status();
  assert.equal(result.components[1].checkError, 'registryUnavailable');
  assert.equal(result.components[1].versionStatus, 'unknown');
  assert.equal(result.components[0].platformCheckRequired, true);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('missing local digests and unsupported platforms cannot offer an update', async () => {
  const { service, docker } = fixture();
  docker.inspectImage = async () => ({
    RepoDigests: [],
    Os: 'linux',
    Architecture: 'arm64',
  });
  assert.ok(
    (await service.status()).components.every(
      (c) => !c.updateAvailable && c.versionStatus === 'unknown',
    ),
  );
});
test('does not contact arbitrary registries from container configuration', async () => {
  const { options, calls } = fixture();
  options.manifest.components = [
    {
      id: 'browser',
      displayName: 'browser',
      allowedImageRepositories: ['localhost:1234/evil'],
    },
  ];
  const result = await new ImageUpdates(options).status();
  assert.equal(result.components[0].checkError, 'unsupportedSource');
  assert.equal(calls.length, 0);
});
test('respects configured compatible tags rather than silently upgrading major versions', async () => {
  const { options, calls } = fixture();
  options.configuration.images.ingress = 'nginx:1.28-alpine';
  await new ImageUpdates(options).status();
  assert.ok(calls.includes('nginx:1.28-alpine'));
});

test('offers explicit migration only for a known local DEV browser image', async () => {
  const { options, docker } = fixture();
  options.manifest.stack = 'mergeron-dev';
  docker.inspectImage = async () => ({
    RepoTags: ['mergeron-dev-browser:local'],
    RepoDigests: [],
    Os: 'linux',
    Architecture: 'amd64',
  });
  const result = await new ImageUpdates(options).status();
  assert.equal(result.components[3].migrationAvailable, true);
  assert.equal(result.components[3].updateAvailable, false);
  assert.equal(result.components[3].versionStatus, 'unknown');
  assert.equal(result.components[0].migrationAvailable, false);
  options.manifest.environment = 'production';
  assert.equal(
    (await new ImageUpdates(options).status()).components[3].migrationAvailable,
    false,
  );
});
