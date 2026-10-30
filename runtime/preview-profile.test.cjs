'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const contract = require('./preview-profile.cjs');

test('preview profiles are disabled by default', () => {
  const p = contract.profile({});
  assert.equal(p.enabled, false);
  assert.equal(p.agentManaged, false);
  assert.deepEqual(p.agentRuntimes, ['node']);
  assert.equal(p.directory, '.');
  assert.equal(p.port, 3000);
  assert.equal(p.lifetimeMinutes, 60);
  assert.equal(p.memoryMb, 1024);
});

test('an administrator may approve 8 GiB without changing other project defaults', () => {
  const p = contract.profile({ memoryMb: 8192 });
  assert.equal(p.memoryMb, 8192);
  assert.equal(p.cpus, 1);
  assert.equal(p.lifetimeMinutes, 60);
  assert.throws(
    () => contract.agentRecipe({ start: 'node server.js', memoryMb: 8192 }),
    /PREVIEW_INVALID_CONFIGURATION/,
  );
});

test('delegated recipes cannot enable projects, raise caps or inherit manual secrets', () => {
  const policy = contract.profile({
    enabled: true,
    agentManaged: true,
    agentRuntimes: ['python', 'postgres'],
    memoryMb: 256,
    cpus: 1,
    lifetimeMinutes: 15,
    env: { PRIVATE_KEY: 'manual-secret' },
  });
  const recipe = {
    runtime: 'python',
    start: 'python -m http.server 8000',
    port: 8000,
    env: { TEST_MODE: 'true' },
    services: [
      {
        name: 'db',
        runtime: 'postgres',
        env: { POSTGRES_PASSWORD: 'temporary-test-value' },
      },
    ],
  };
  const applied = contract.agentProfile(policy, recipe);
  assert.equal(applied.memoryMb, 256);
  assert.equal(applied.cpus, 1);
  assert.equal(applied.lifetimeMinutes, 15);
  assert.equal(applied.env.PRIVATE_KEY, undefined);
  assert.throws(
    () => contract.agentProfile({ ...policy, enabled: false }, recipe),
    /PREVIEW_AGENT_NOT_AUTHORIZED/,
  );
  assert.throws(
    () => contract.agentProfile({ ...policy, agentManaged: false }, recipe),
    /PREVIEW_AGENT_NOT_AUTHORIZED/,
  );
  assert.throws(
    () =>
      contract.agentProfile({ ...policy, agentRuntimes: ['python'] }, recipe),
    /PREVIEW_RUNTIME_NOT_ALLOWED/,
  );
  for (const extra of [
    { enabled: true },
    { agentManaged: true },
    { memoryMb: 4096 },
    { cpus: 4 },
    { lifetimeMinutes: 240 },
    { image: 'x' },
    { mounts: [] },
    { url: 'https://example.org' },
  ])
    assert.throws(
      () => contract.agentRecipe({ ...recipe, ...extra }),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
  assert.throws(
    () => contract.agentRecipe({ ...recipe, env: { PRIVATE_KEY: '[stored]' } }),
    /PREVIEW_INVALID_CONFIGURATION/,
  );
});

test('profiles support unrelated Node and Python projects without Mergeron commands', () => {
  const node = contract.profile({
    enabled: true,
    runtime: 'node',
    directory: 'apps/frontend',
    install: 'npm ci',
    start: 'npm run dev -- --host 0.0.0.0',
    port: 5173,
  });
  const python = contract.profile({
    enabled: true,
    runtime: 'python',
    start: 'python -m http.server 8000 --bind 0.0.0.0',
    port: 8000,
  });
  assert.equal(node.port, 5173);
  assert.equal(python.runtime, 'python');
  assert.notEqual(contract.fingerprint(node), contract.fingerprint(python));
});

test('Docker images, host mounts and privileged options cannot enter the wire profile', () => {
  for (const key of [
    'image',
    'volumes',
    'mounts',
    'privileged',
    'networkMode',
    'dockerSocket',
  ]) {
    assert.throws(
      () => contract.profile({ [key]: true }),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
  }
  assert.throws(
    () =>
      contract.profile({
        services: [{ name: 'db', runtime: 'postgres', image: 'postgres' }],
      }),
    /PREVIEW_INVALID_CONFIGURATION/,
  );
});

test('source directory and initial page cannot escape their scope', () => {
  for (const directory of [
    '/etc',
    '../other',
    'a/../b',
    'a//b',
    'a\\b',
    'a/./b',
  ])
    assert.throws(
      () => contract.profile({ directory }),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
  for (const path of [
    '//example.com',
    'https://example.com',
    '/\r\nHost:x',
    '/x#fragment',
  ])
    assert.throws(
      () => contract.profile({ path }),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
});

test('environment overrides cannot disable the egress transport or load native code', () => {
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'PATH',
    'HOME',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'COREPACK_HOME',
    'PNPM_HOME',
    'NODE_OPTIONS',
    'NODE_USE_ENV_PROXY',
    'LD_PRELOAD',
    'DOCKER_HOST',
    'MERGERON_PREVIEW_TARGET',
  ])
    assert.throws(
      () => contract.profile({ env: { [key]: 'x' } }),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
  assert.throws(
    () =>
      contract.agentRecipe({
        start: 'node server.js',
        env: { NODE_USE_ENV_PROXY: '0' },
      }),
    /PREVIEW_INVALID_CONFIGURATION/,
  );
  assert.throws(
    () =>
      contract.profile({
        services: [
          { name: 'api', runtime: 'node', env: { NODE_USE_ENV_PROXY: '0' } },
        ],
      }),
    /PREVIEW_INVALID_CONFIGURATION/,
  );
  for (const env of [null, [], 1, 'x'])
    assert.throws(
      () => contract.profile({ env }),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
});

test('safe settings redact all application and service environment values', () => {
  const p = contract.safeProfile({
    env: { TEST_API_KEY: 'application-secret' },
    services: [
      {
        name: 'database',
        runtime: 'postgres',
        env: { POSTGRES_PASSWORD: 'database-secret' },
      },
    ],
  });
  assert.deepEqual(p.env, { TEST_API_KEY: '[stored]' });
  assert.deepEqual(p.services[0].env, { POSTGRES_PASSWORD: '[stored]' });
  assert.ok(!JSON.stringify(p).includes('application-secret'));
  assert.ok(!JSON.stringify(p).includes('database-secret'));
});

test('limits fail closed, including the total request body size', () => {
  for (const values of [
    { memoryMb: 8193 },
    { cpus: 5 },
    { port: 80 },
    { lifetimeMinutes: 241 },
    { services: Array(4).fill({ name: 'x', runtime: 'node' }) },
  ])
    assert.throws(
      () => contract.profile(values),
      /PREVIEW_INVALID_CONFIGURATION/,
    );
  const env = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => ['TEST_' + i, 'x'.repeat(4096)]),
  );
  assert.throws(
    () => contract.profile({ env }),
    /PREVIEW_INVALID_CONFIGURATION/,
  );
});
