import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installBundle,
  ManagedCodexCli,
  assertCliPolicyImage,
} from '../src/codex-cli.mjs';
import runtime from '../../runtime/managed-cli.cjs';
import testing from '../../runtime/testing.cjs';
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'manager-cli-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  fs.mkdirSync(home);
  const value = testing.bundle(root);
  const expected = {
    releaseId: value.data.id,
    manifestSha256: value.data.manifestSha256,
  };
  return { root, home, ...value, expected };
}
test('installs offline without touching selection, auth, config or other home files', (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.home, '.codex'));
  fs.writeFileSync(join(f.home, '.codex/auth.json'), 'private account');
  installBundle(f.directory, f.home, f.expected);
  assert.equal(
    fs.readFileSync(join(f.home, '.codex/auth.json'), 'utf8'),
    'private account',
  );
  assert.equal(
    fs.existsSync(join(f.home, '.codex/webui/cli/selection.json')),
    false,
  );
  const selected = runtime.approvedSelection(join(f.home, '.codex'), {
    id: f.data.id,
    manifestSha256: f.data.manifestSha256,
  });
  fs.writeFileSync(
    join(f.home, '.codex/webui/cli/selection.json'),
    JSON.stringify(selected),
  );
  assert.equal(
    runtime.selected(join(f.home, '.codex')),
    runtime.binary(join(f.home, '.codex'), f.data.id),
  );
  installBundle(f.directory, f.home, f.expected); // verified idempotency, no overwrite
});
test('never overwrites a conflicting immutable release', (t) => {
  const f = fixture(t);
  installBundle(f.directory, f.home, f.expected);
  const file = join(
    f.home,
    '.codex/webui/cli/releases',
    f.data.id,
    f.data.native,
  );
  fs.chmodSync(file, 0o755);
  fs.writeFileSync(file, 'tampered');
  fs.chmodSync(file, 0o555);
  assert.throws(
    () => installBundle(f.directory, f.home, f.expected),
    /Integrity/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'tampered');
});
test('rejects symlinked home ancestors before writing outside the managed home', (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(f.home, '.codex'));
  assert.throws(
    () => installBundle(f.directory, f.home, f.expected),
    /UnsafeHome/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('rejects stale package identity before creating any directory', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      installBundle(f.directory, f.home, {
        ...f.expected,
        releaseId: '9.9.9-mergeron.1',
      }),
    /PlanChanged/,
  );
  assert.deepEqual(fs.readdirSync(f.home), []);
});
function managedFixture(t, options = {}) {
  const f = fixture(t);
  const calls = [];
  const app = {
    Id: 'application-id',
    Name: '/test-ui',
    Image: 'app',
    Config: {
      Image: 'ghcr.io/maxhugit/mergeron:latest',
      User: '11002:11002',
      Labels: {
        'io.mergeron.managed': 'true',
        'io.mergeron.stack': 'test',
        'io.mergeron.component': 'application',
      },
    },
    Mounts: [
      {
        Type: 'bind',
        RW: true,
        Source: '/state/home',
        Destination: '/home/codex',
      },
    ],
  };
  if (options.unlabeled) app.Config.Labels = {};
  options.mutate?.(app);
  const docker = {
    inspectContainer: async (id) =>
      id === 'manager-self'
        ? { Image: `sha256:${'c'.repeat(64)}` }
        : id === 'helper'
          ? { State: { Running: false } }
          : app,
    inspectImage: async (id) =>
      id === 'app'
        ? {
            Architecture: 'amd64',
            Os: 'linux',
            Config: { Labels: { 'io.mergeron.cli-policy': '1' } },
          }
        : {
            Config: {
              Labels: { 'org.opencontainers.image.title': 'Mergeron Manager' },
            },
          },
    createContainer: async (name, spec) => {
      calls.push(spec);
      return { Id: 'helper' };
    },
    startContainer: async () => {},
    waitContainer: async () => ({ StatusCode: 0 }),
    removeContainer: async (id) => calls.push(['remove', id]),
  };
  const cli = new ManagedCodexCli({
    docker,
    manifest: {
      stack: 'test',
      components: [{ id: 'application', canonicalName: 'test-ui' }],
    },
    configuration: { stateRoot: '/state' },
    inventory: options.inventory,
    bundle: f.directory,
    self: 'manager-self',
  });
  return { cli, calls, f, app };
}
function adoptedInventory() {
  return {
    stack: 'test',
    adoption: { state: 'adopted', blockers: [] },
    dataSafety: { status: 'protected' },
    components: [
      {
        id: 'application',
        adoption: 'managed',
        containerId: 'application-id',
        containerName: 'test-ui',
        image: 'ghcr.io/maxhugit/mergeron:latest',
        imageRepositoryAllowed: true,
      },
    ],
  };
}
test('Manager uses only its own immutable image in an unprivileged network-none helper', async (t) => {
  const { cli, calls, f } = managedFixture(t);
  await cli.install(f.expected);
  const spec = calls[0];
  assert.equal(spec.User, '11002:11002');
  assert.equal(spec.HostConfig.NetworkMode, 'none');
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert.equal(spec.HostConfig.Memory, 512 * 1024 ** 2);
  assert.deepEqual(spec.HostConfig.Mounts, [
    {
      Type: 'bind',
      Source: '/state/home',
      Target: '/managed-home',
      ReadOnly: false,
    },
  ]);
  assert.deepEqual(spec.Env, ['NODE_ENV=production']);
  assert.deepEqual(calls.at(-1), ['remove', 'helper']);
  assert.equal(cli.busy, false);
});
test('accepts an unlabeled application only after exact verified adoption', async (t) => {
  const { cli, f, calls } = managedFixture(t, {
    unlabeled: true,
    inventory: async () => adoptedInventory(),
  });
  await cli.install(f.expected);
  assert.equal(calls[0].HostConfig.NetworkMode, 'none');
  assert.equal(calls[0].User, '11002:11002');
});
for (const [name, change] of [
  [
    'no adoption',
    (s) => {
      s.adoption.state = 'eligible';
    },
  ],
  [
    'stale adoption',
    (s) => {
      s.adoption.state = 'drifted';
    },
  ],
  [
    'blockers',
    (s) => {
      s.adoption.blockers = ['unsafe'];
    },
  ],
  [
    'wrong stack',
    (s) => {
      s.stack = 'other';
    },
  ],
  [
    'replaced container',
    (s) => {
      s.components[0].containerId = 'replacement';
    },
  ],
  [
    'changed image',
    (s) => {
      s.components[0].image = 'other:latest';
    },
  ],
  [
    'unsafe repository',
    (s) => {
      s.components[0].imageRepositoryAllowed = false;
    },
  ],
])
  test(`rejects unlabeled applications with ${name}`, async (t) => {
    const inventory = adoptedInventory();
    change(inventory);
    const { cli, f, calls } = managedFixture(t, {
      unlabeled: true,
      inventory: async () => inventory,
    });
    await assert.rejects(
      cli.install(f.expected),
      /codexRuntimeApplicationNotManaged/,
    );
    assert.equal(calls.length, 0);
  });
test('does not override conflicting ownership labels even with an adoption callback', async (t) => {
  const { cli, f, calls } = managedFixture(t, {
    mutate: (app) => {
      app.Config.Labels['io.mergeron.stack'] = 'foreign';
    },
    inventory: async () => adoptedInventory(),
  });
  await assert.rejects(
    cli.install(f.expected),
    /codexRuntimeApplicationNotManaged/,
  );
  assert.equal(calls.length, 0);
});
test('keeps the managed home validation for adopted applications', async (t) => {
  const { cli, f, calls } = managedFixture(t, {
    unlabeled: true,
    mutate: (app) => {
      app.Mounts[0].Source = '/outside/home';
    },
    inventory: async () => adoptedInventory(),
  });
  await assert.rejects(cli.install(f.expected), /codexRuntimeUnsafeHome/);
  assert.equal(calls.length, 0);
});
test('Manager rejects images that would remove an active CLI protection', (t) => {
  const f = fixture(t);
  installBundle(f.directory, f.home, f.expected);
  const home = join(f.home, '.codex');
  fs.writeFileSync(
    join(runtime.root(home), 'selection.json'),
    JSON.stringify(
      runtime.approvedSelection(home, {
        id: f.data.id,
        manifestSha256: f.data.manifestSha256,
      }),
    ),
  );
  assert.throws(
    () =>
      assertCliPolicyImage(
        { hostStatePath: f.root },
        { Config: { Labels: {} } },
      ),
    /ProtectionRequired/,
  );
  assert.doesNotThrow(() =>
    assertCliPolicyImage(
      { hostStatePath: f.root },
      { Config: { Labels: { 'io.mergeron.cli-policy': '1' } } },
    ),
  );
});
