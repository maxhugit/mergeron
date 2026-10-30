import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { scopeManifest } from '../src/inventory.mjs';
import { readInstallConfiguration } from '../src/installer.mjs';

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const guide = read('docs/installation.md');
const reference = read('docs/variables-manager.md');
const manifest = JSON.parse(read('manager/stack-manifest.json'));
const example = Object.fromEntries(
  read('deployment/manager.env.example')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = /^([A-Z_0-9]+)=(.*)$/.exec(line);
      assert.ok(match, `Invalid environment example line: ${line}`);
      return match.slice(1);
    }),
);

test('the documented Manager example is accepted without enabling optional services', () => {
  const scoped = scopeManifest(
    manifest,
    example.MERGERON_STACK_PREFIX,
    example.MERGERON_STACK_ENVIRONMENT,
    example.MERGERON_PROXY_NETWORK,
    { enabled: example.MERGERON_MANAGE_BROWSER === 'true' },
  );
  const configuration = readInstallConfiguration(scoped, example);
  assert.equal(configuration.enabled, false);
  assert.equal(configuration.previewsEnabled, false);
  assert.equal(configuration.authMode, 'native');
  assert.equal(configuration.hostIntegration, 'none');
  assert.equal(configuration.stateRoot, '/srv/mergeron/state');
  assert.equal(configuration.appdataRoot, '/srv/mergeron/state/appdata');
  assert.equal(configuration.publicUrl, 'https://mergeron.example.com');
  assert.equal(
    configuration.images.application,
    'ghcr.io/maxhugit/mergeron:edge',
  );
  assert.equal(scoped.components.length, 3);
});

test('the operator reference covers Manager settings consumed by the implementation', () => {
  const settings = new Set();
  for (const path of [
    'manager/src/server.mjs',
    'manager/src/installer.mjs',
    'manager/src/previews.mjs',
    'manager/src/integrations/host-platform.mjs',
  ]) {
    for (const [, name] of read(path).matchAll(
      /(?:process\.)?env\.(MERGERON_[A-Z_0-9]+)/g,
    )) {
      // Compatibility aliases are not a second configuration surface for new installs.
      if (name === 'MERGERON_UNRAID_APPDATA_ROOT') continue;
      settings.add(name);
    }
  }
  for (const name of settings) {
    assert.ok(
      reference.includes(`\`${name}\``),
      `Undocumented setting: ${name}`,
    );
  }
  for (const name of Object.keys(example))
    assert.ok(settings.has(name), `Unknown example setting: ${name}`);
});

test('installation commands parse without executing or exposing a Docker endpoint', () => {
  for (const [, script] of guide.matchAll(/```sh\n([\s\S]*?)```/g)) {
    const result = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const option of [
    '--network none',
    '--read-only',
    '--cap-drop ALL',
    '--cap-add CHOWN',
    '--cap-add DAC_READ_SEARCH',
    '--security-opt no-new-privileges:true',
    '--memory 512m',
    '--env-file /srv/mergeron/manager.env',
  ])
    assert.ok(guide.includes(option), `Missing launch safeguard: ${option}`);
  assert.ok(!guide.includes('--privileged'));
  assert.ok(!/docker run[^`]*--publish/.test(guide));
  assert.ok(guide.includes('provision-person.cjs'));
  assert.ok(guide.includes('La version actuelle n’a pas de formulaire public'));
});

test('the installation entry points link one Manager journey without environment-specific providers', () => {
  for (const path of ['README.md', 'docs/README.md', 'deployment/README.md']) {
    assert.ok(
      read(path).includes('installation.md'),
      `${path} does not link the installation guide`,
    );
  }
  for (const path of [
    'README.md',
    'docs/installation.md',
    'docs/installation-portable.md',
    'docs/architecture.md',
  ]) {
    const content = read(path);
    assert.ok(
      !/hugotlab|Home Assistant|HA-MCP|Authentik|Traefik|VPS SSH/i.test(
        content,
      ),
      path,
    );
    assert.ok(
      !/migration-mergeron|choisir-mode-installation|unraid-compose\.md|unraid-dockerman\.md/.test(
        content,
      ),
      path,
    );
  }
});
