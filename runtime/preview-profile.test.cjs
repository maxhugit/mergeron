'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const contract = require('./preview-profile.cjs');

test('preview profiles are disabled by default', () => {
  const p = contract.profile({});
  assert.equal(p.enabled, false);
  assert.equal(p.directory, '.');
  assert.equal(p.port, 3000);
  assert.equal(p.lifetimeMinutes, 60);
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
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DOCKER_HOST',
    'MERGERON_PREVIEW_TARGET',
  ])
    assert.throws(
      () => contract.profile({ env: { [key]: 'x' } }),
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
    { memoryMb: 4097 },
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
