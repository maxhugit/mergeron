import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppCatalogRunner, BYPARR_IMAGE } from '../src/app-catalog/runner.mjs';
const manifest = {
  stack: 'test',
  networks: [{ id: 'isolated', name: 'test-isolated', internal: true }],
};
function fixture() {
  let current = null,
    spec,
    starts = 0,
    stops = 0,
    pulls = 0;
  const docker = {
    inspectImage: async () => ({ Id: 'sha256:reviewed' }),
    inspectContainer: async () => {
      if (!current) throw Object.assign(Error(), { statusCode: 404 });
      return current;
    },
    createContainer: async (_name, s) => {
      spec = s;
      current = {
        Id: 'helper',
        Image: 'sha256:reviewed',
        Config: { Labels: s.Labels, User: s.User },
        HostConfig: s.HostConfig,
        Mounts: [],
        State: { Running: false },
      };
      return { Id: 'helper' };
    },
    startContainer: async () => {
      starts++;
      current.State.Running = true;
    },
    stopContainer: async () => {
      stops++;
      current.State.Running = false;
    },
    catalogJob: async () => ({ apps: [{ id: 'x', name: 'X' }] }),
    pullImage: async () => {
      pulls++;
    },
  };
  return {
    docker,
    runner: new AppCatalogRunner({ docker, manifest, enabled: true }),
    get spec() {
      return spec;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get pulls() {
      return pulls;
    },
    get current() {
      return current;
    },
  };
}
test('keeps one managed Byparr container, clears sessions after each job and never puts credentials in Docker config', async () => {
  const f = fixture();
  await f.runner.prepare();
  await f.runner.download({
    accessToken: 'private-token',
    accountId: 'account',
  });
  await f.runner.download({
    accessToken: 'private-token',
    accountId: 'account',
  });
  assert.equal(f.stops, 2);
  assert.equal(f.current.State.Running, true);
  assert.equal(f.spec.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(f.spec.HostConfig.NetworkMode, 'test-isolated');
  assert.equal(f.spec.HostConfig.Binds, undefined);
  assert.equal(f.spec.HostConfig.PortBindings, undefined);
  assert.ok(!JSON.stringify(f.spec).includes('private-token'));
  assert.ok(!JSON.stringify(f.spec).includes('ignore_https_errors'));
  assert.equal(f.spec.Labels['io.mergeron.component'], 'appCatalog');
  assert.ok(f.spec.Healthcheck);
});
test('cleans the browser even after download failure', async () => {
  const f = fixture();
  await f.runner.prepare();
  f.docker.catalogJob = async () => {
    throw Error('upstream private data');
  };
  await assert.rejects(
    f.runner.download({ accessToken: 'x', accountId: 'y' }),
    /CATALOG_WORKER_UNAVAILABLE/,
  );
  assert.equal(f.stops, 1);
  assert.equal(f.runner.busy, false);
});
test('refuses unowned containers and mismatched executable images', async () => {
  const f = fixture();
  await f.runner.prepare();
  f.current.Config.Labels['io.mergeron.stack'] = 'other';
  await assert.rejects(
    f.runner.download({ accessToken: 'x', accountId: 'y' }),
    /CATALOG_OWNERSHIP/,
  );
  assert.equal(f.stops, 0);
  f.current.Config.Labels['io.mergeron.stack'] = 'test';
  f.current.Image = 'sha256:other';
  await assert.rejects(
    f.runner.download({ accessToken: 'x', accountId: 'y' }),
    /CATALOG_IMAGE_CHANGED/,
  );
});
test('disabled adapter never contacts Docker', async () => {
  const runner = new AppCatalogRunner({ docker: {}, manifest });
  await assert.rejects(runner.prepare(), /CATALOG_DISABLED/);
});
test('pins the tested vendor executable', () => {
  assert.match(BYPARR_IMAGE, /@sha256:[a-f0-9]{64}$/);
});

test('worker pagination, TLS and header isolation run without a real browser or credentials', async () => {
  const { spawnSync } = await import('node:child_process');
  const path = new URL('./app_catalog_worker_test.py', import.meta.url);
  const result = spawnSync('python3', [path.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('reports a browser reset failure rather than claiming a successful download', async () => {
  const f = fixture();
  await f.runner.prepare();
  f.docker.stopContainer = async () => {
    throw Error('private daemon error');
  };
  await assert.rejects(
    f.runner.download({ accessToken: 'x', accountId: 'y' }),
    /CATALOG_CLEANUP_FAILED/,
  );
  assert.equal(f.runner.busy, false);
});

test('reports the permanent auxiliary service without changing the core stack inventory', async () => {
  const f = fixture();
  assert.equal((await f.runner.status()).present, false);
  await f.runner.prepare();
  f.docker.inspectImage = async () => ({
    Id: 'sha256:reviewed',
    Config: { Env: ['VERSION=3.0.4'] },
  });
  f.current.State.Health = { Status: 'healthy' };
  assert.deepEqual(await f.runner.status(), {
    enabled: true,
    present: true,
    running: true,
    healthy: true,
    version: '3.0.4',
    error: null,
  });
});
