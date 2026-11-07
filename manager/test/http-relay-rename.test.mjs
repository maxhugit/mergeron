import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatewaySpecification,
  gatewayRouting,
  installGateways,
} from '../scripts/install-update-gateway.mjs';
import { renameHttpRelays } from '../scripts/rename-http-relays.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'proxy'));
  const config = {
    stack: 'mergeron-dev',
    hostname: 'dev.example.com',
    image: `ghcr.io/maxhugit/mergeron-manager@sha256:${'a'.repeat(64)}`,
    stateRoot: root,
    network: 'proxy',
    applicationMiddlewares: [],
    proxyDirectory: join(root, 'proxy'),
  };
  const spec = gatewaySpecification(config);
  const values = new Map(
    ['a', 'b'].map((slot, index) => [
      slot,
      {
        Id: slot,
        Name: `/mergeron-dev-update-gateway-${slot}`,
        Config: {
          Image: spec.Image,
          User: spec.User,
          Env: spec.Env,
          Labels: spec.Labels,
        },
        HostConfig: spec.HostConfig,
        State: { Running: true, Health: { Status: 'healthy' } },
        NetworkSettings: {
          Networks: { proxy: { IPAddress: `172.30.0.${index + 2}` } },
        },
      },
    ]),
  );
  const calls = [];
  const docker = {
    listNetworks: async () => [{ Name: 'proxy' }],
    listContainers: async () =>
      [...values.values()].map((v) => ({ Id: v.Id, Names: [v.Name] })),
    inspectContainer: async (id) => structuredClone(values.get(id)),
    renameContainer: async (id, name) => {
      calls.push([id, name]);
      values.get(id).Name = '/' + name;
    },
    stopContainer: async () => {
      throw new Error('must not stop relays');
    },
    removeContainer: async () => {
      throw new Error('must not delete relays');
    },
  };
  const path = join(config.proxyDirectory, 'mergeron-dev-continuous.yml');
  const verify = async (_host, marker) => {
    const route = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(
      route.http.middlewares['mergeron-dev-continuous-security'].headers
        .customResponseHeaders?.['X-Mergeron-Relay-Rename'] ?? null,
      marker,
    );
    for (const server of route.http.services['mergeron-dev-continuous']
      .loadBalancer.servers) {
      const host = new URL(server.url).hostname;
      assert(
        [...values.values()].some(
          (v) =>
            v.Name === '/' + host ||
            v.NetworkSettings.Networks.proxy.IPAddress === host,
        ),
        'proxy points only to existing reachable relays',
      );
    }
  };
  return { config, docker, calls, values, path, verify };
}
test('new installations use permanent web-access names', () => {
  const route = gatewayRouting({
    stack: 'mergeron-dev',
    hostname: 'dev.example.com',
  });
  assert.deepEqual(
    route.http.services['mergeron-dev-continuous'].loadBalancer.servers.map(
      (s) => s.url,
    ),
    [
      'http://mergeron-dev-acces-web-1:8080',
      'http://mergeron-dev-acces-web-2:8080',
    ],
  );
});
test('ordinary provisioning keeps existing names until an explicit migration', async (t) => {
  const f = await fixture(t);
  await installGateways(f.config, f.docker);
  assert.deepEqual(f.calls, []);
  const route = JSON.parse(await readFile(f.path, 'utf8'));
  assert(
    route.http.services[
      'mergeron-dev-continuous'
    ].loadBalancer.servers[0].url.includes('update-gateway-a'),
  );
});
test('renames the same healthy replicas only after IP routing acknowledgement and is idempotent', async (t) => {
  const f = await fixture(t);
  const original = [...f.values.values()].map((v) =>
    structuredClone(v.HostConfig),
  );
  await renameHttpRelays(f.config, f.docker, f.verify);
  assert.deepEqual(f.calls, [
    ['a', 'mergeron-dev-acces-web-1'],
    ['b', 'mergeron-dev-acces-web-2'],
  ]);
  assert.deepEqual(
    [...f.values.values()].map((v) => v.HostConfig),
    original,
  );
  await renameHttpRelays(f.config, f.docker, f.verify);
  assert.equal(f.calls.length, 2);
});
test('a proxy acknowledgement failure before rename leaves existing identities intact', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () =>
      renameHttpRelays(f.config, f.docker, async () => {
        throw new Error('proxy not ready');
      }),
    /proxy not ready/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.values.get('a').Name, '/mergeron-dev-update-gateway-a');
});
test('failed named routing restores IP routing before rolling container names back', async (t) => {
  const f = await fixture(t);
  let fail = true;
  await assert.rejects(
    () =>
      renameHttpRelays(f.config, f.docker, async (host, marker) => {
        await f.verify(host, marker);
        if (marker?.endsWith('-named') && fail) {
          fail = false;
          throw new Error('named routing failed');
        }
      }),
    /named routing failed/,
  );
  assert.equal(f.values.get('a').Name, '/mergeron-dev-update-gateway-a');
  assert.equal(f.values.get('b').Name, '/mergeron-dev-update-gateway-b');
});

test('preserves the existing authentication chain when provisioning and renaming relays', async (t) => {
  const f = await fixture(t);
  f.config.applicationMiddlewares = ['authentik@file', 'site-security'];
  await installGateways(f.config, f.docker);
  const initial = JSON.parse(await readFile(f.path, 'utf8'));
  initial.http.middlewares.authentik = {
    forwardAuth: { address: 'http://sso.test/check' },
  };
  initial.http.routers.office = {
    rule: 'PathPrefix(`/office`)',
    service: 'office',
  };
  initial.http.middlewares[
    'mergeron-dev-continuous-security'
  ].headers.customResponseHeaders = { 'X-Keep': 'retained' };
  await writeFile(f.path, JSON.stringify(initial));
  delete f.config.applicationMiddlewares;
  await renameHttpRelays(f.config, f.docker, f.verify);
  const route = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(route.http.routers['mergeron-dev-continuous'].middlewares, [
    'authentik@file',
    'site-security',
    'mergeron-dev-continuous-security',
  ]);
  assert.deepEqual(
    route.http.middlewares.authentik,
    initial.http.middlewares.authentik,
  );
  assert.deepEqual(route.http.routers.office, initial.http.routers.office);
  assert.equal(
    route.http.middlewares['mergeron-dev-continuous-security'].headers
      .customResponseHeaders['X-Keep'],
    'retained',
  );
  // Independent monitoring authenticates with its scoped cookie, not forward-auth.
  assert.equal(
    route.http.routers['mergeron-dev-monitor'].middlewares,
    undefined,
  );
  f.config.applicationMiddlewares = [];
  await assert.rejects(
    installGateways(f.config, f.docker),
    /must not be removed/,
  );
});

test('refuses an implicit first middleware chain or a missing network before changing replicas', async (t) => {
  const f = await fixture(t);
  delete f.config.applicationMiddlewares;
  await assert.rejects(
    installGateways(f.config, f.docker),
    /Explicit application middlewares/,
  );
  assert.deepEqual(f.calls, []);
  f.config.applicationMiddlewares = [];
  f.docker.listNetworks = async () => [];
  await assert.rejects(
    installGateways(f.config, f.docker),
    /Gateway network not found/,
  );
  assert.deepEqual(f.calls, []);
});

test('retries a never-started relay without stopping an already stopped container', async (t) => {
  const f = await fixture(t);
  f.values.get('a').State = { Running: false, Status: 'created' };
  f.docker.removeContainer = async (id) => f.values.delete(id);
  f.docker.createContainer = async (name, spec) => {
    f.values.set('new', {
      ...structuredClone(f.values.get('b')),
      Id: 'new',
      Name: '/' + name,
      Config: { ...spec },
      HostConfig: spec.HostConfig,
    });
    return { Id: 'new' };
  };
  f.docker.startContainer = async () => {};
  await installGateways(f.config, f.docker);
  assert(f.values.has('new'));
});

test('does not overwrite unreadable existing proxy configuration even with explicit middlewares', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, 'not generated JSON: keep');
  await assert.rejects(installGateways(f.config, f.docker), SyntaxError);
  assert.equal(await readFile(f.path, 'utf8'), 'not generated JSON: keep');
  assert.deepEqual(f.calls, []);
});
