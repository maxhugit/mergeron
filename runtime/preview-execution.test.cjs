'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executionCheck } = require('./preview-execution.cjs');
const profile = (extra = {}) => ({
  env: {},
  start: 'node server.js',
  port: 3000,
  updateMode: 'hot',
  ...extra,
});
test('custom scripts remain unknown and no shell execution is attempted', () => {
  const result = executionCheck(profile({ start: 'npm run dev' }));
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.issues, [
    { code: 'commandUnknown', severity: 'warning' },
  ]);
  assert.equal(
    executionCheck(profile({ start: 'echo next dev && node app.js' })).kind,
    'custom',
  );
});
test('known dev and production commands require a coherent mode; inline overrides are explicit', () => {
  assert.equal(
    executionCheck(profile({ start: 'next dev --hostname 0.0.0.0' })).valid,
    true,
  );
  assert.equal(
    executionCheck(
      profile({
        start: 'next start',
        env: { NODE_ENV: 'production' },
        updateMode: 'restart',
      }),
    ).valid,
    true,
  );
  assert.equal(
    executionCheck(profile({ start: 'pnpm exec vite preview' })).valid,
    false,
  );
  assert.equal(
    executionCheck(
      profile({ start: 'next dev', env: { NODE_ENV: 'production' } }),
    ).valid,
    false,
  );
  assert.ok(
    executionCheck(
      profile({ start: 'NODE_ENV=production next start' }),
    ).issues.some((i) => i.code === 'modeOverride'),
  );
});
test('PORT conflicts and detached servers block launch without disclosing stored values', () => {
  assert.equal(executionCheck(profile({ env: { PORT: '3000' } })).valid, true);
  assert.equal(
    executionCheck(profile({ start: 'next dev --port=4000' })).valid,
    false,
  );
  assert.equal(
    executionCheck(profile({ start: 'next dev -p 3000' })).valid,
    true,
  );
  assert.equal(
    executionCheck(profile({ start: 'next dev --port "3000"' })).kind,
    'custom',
  );
  assert.equal(executionCheck(profile({ env: { PORT: '4000' } })).valid, false);
  assert.equal(
    executionCheck(profile({ start: 'node app.js &' })).valid,
    false,
  );
  assert.equal(
    executionCheck(profile({ start: 'node app.js & wait' })).valid,
    true,
  );
  const result = executionCheck(
    profile({
      env: {
        NODE_ENV: 'secret-mode',
        PORT: 'secret-port',
        PASSWORD: 'private',
      },
    }),
  );
  assert.equal(result.mode, 'unknown');
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-mode|secret-port|private/,
  );
});
