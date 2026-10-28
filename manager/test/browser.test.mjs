import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { scopeManifest } from '../src/inventory.mjs';
import { specification, TransactionalUpdater } from '../src/updater.mjs';
import { readInstallConfiguration } from '../src/installer.mjs';
const manifest = JSON.parse(
  await readFile(new URL('../stack-manifest.json', import.meta.url)),
);
test('managed browser remains opt-in in production and development', () => {
  assert.equal(scopeManifest(manifest).components.length, 3);
  const prod = scopeManifest(manifest, 'mergeron', 'production', undefined, {
    enabled: true,
  });
  const prodBrowser = prod.components.find((c) => c.id === 'browser');
  assert.equal(prodBrowser.canonicalName, 'mergeron-browser');
  assert.equal(prodBrowser.existingOnly, true);
  assert.deepEqual(prodBrowser.allowedImageRepositories, [
    'ghcr.io/maxhugit/mergeron-browser',
  ]);
  assert.deepEqual(prodBrowser.requiredNetworks, [
    'mergeron-browser-control',
    'mergeron-browser-egress',
  ]);
  assert.equal(readInstallConfiguration(prod, {}).images.browser, undefined);
  assert.match(
    readInstallConfiguration(prod, {}).images.application,
    /mergeron:latest$/,
  );
  assert.throws(
    () =>
      scopeManifest(manifest, 'mergeron-dev', 'development', undefined, {
        enabled: true,
        dns: ['192.168.100.5'],
      }),
    /public DNS/,
  );
  const dev = scopeManifest(
    manifest,
    'mergeron-dev',
    'development',
    undefined,
    { enabled: true },
  );
  const browser = dev.components.find((c) => c.id === 'browser');
  assert.equal(browser.canonicalName, 'mergeron-dev-browser');
  assert.equal(browser.existingOnly, true);
  assert.deepEqual(browser.requiredNetworks, [
    'mergeron-dev-browser-control',
    'mergeron-dev-browser-egress',
  ]);
  assert.deepEqual(browser.dns, ['1.1.1.1']);
  const configuration = readInstallConfiguration(dev, {});
  assert.equal(configuration.images.browser, undefined);
  assert.match(configuration.images.application, /mergeron:edge$/);
});
test('browser recreation and rollback enforce DNS while preserving sandbox and secret', () => {
  const browser = { id: 'browser', dns: ['1.1.1.1'] };
  const original = {
    Id: 'old',
    Config: { Env: ['BROWSER_WS_PATH=secret'] },
    HostConfig: {
      Dns: [],
      CapDrop: ['ALL'],
      SecurityOpt: ['seccomp=profile'],
      ReadonlyRootfs: true,
    },
    NetworkSettings: {
      Networks: { control: { Aliases: ['old', 'mergeron-dev-browser'] } },
    },
  };
  for (const image of ['previous', 'next']) {
    const spec = specification(original, image, browser);
    assert.deepEqual(spec.HostConfig.Dns, ['1.1.1.1']);
    assert.deepEqual(
      spec.HostConfig.SecurityOpt,
      original.HostConfig.SecurityOpt,
    );
    assert.deepEqual(spec.Config, undefined);
    assert.deepEqual(spec.Env, original.Config.Env);
    assert.deepEqual(spec.NetworkingConfig.EndpointsConfig.control.Aliases, [
      'mergeron-dev-browser',
    ]);
  }
  assert.deepEqual(original.HostConfig.Dns, []);
  assert.deepEqual(specification(original, 'next').HostConfig.Dns, []);
});
test('browser starts before application and is included in stopping order', async () => {
  const calls = [];
  const updater = new TransactionalUpdater({
    docker: {
      inspectContainer: async (id) => ({
        State: { Running: calls.includes(id), Health: { Status: 'healthy' } },
      }),
      startContainer: async (id) => calls.push(id),
    },
  });
  updater.current = {
    containers: ['application', 'ingress', 'browser', 'egress'].map(
      (component) => ({ component, id: component }),
    ),
  };
  assert.deepEqual(
    updater.stopOrder().map((c) => c.component),
    ['ingress', 'application', 'browser', 'egress'],
  );
  await updater.startAndCheck(updater.current.containers);
  assert.deepEqual(calls, ['egress', 'browser', 'application', 'ingress']);
});
