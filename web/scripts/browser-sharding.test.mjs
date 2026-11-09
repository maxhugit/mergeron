import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BaseSequencer, createVitest } from 'vitest/node';
import { browserRunPlan, runBrowserTests } from './run-browser-tests.mjs';
import { retryableWebkitDisconnect } from './run-browser-tests.mjs';

const disconnected =
  '[vitest] Browser connection was closed while running tests. Was the page closed unexpectedly?';
test('only a pure runner disconnect is eligible for a fresh full WebKit attempt', () => {
  assert.equal(
    retryableWebkitDisconnect({ status: 1, stderr: disconnected }),
    true,
  );
  for (const failure of [
    'AssertionError: wrong value',
    'FAIL browser test',
    'Tests  1 failed | 4 passed',
    'Test Files 2 failed',
    'Test timed out',
  ])
    assert.equal(
      retryableWebkitDisconnect({
        status: 1,
        stderr: disconnected + '\n' + failure,
      }),
      false,
    );
  assert.equal(
    retryableWebkitDisconnect({
      status: null,
      signal: 'SIGTERM',
      stderr: disconnected,
    }),
    false,
  );
});
test('runner retries the complete WebKit shard once, retains evidence and never hides a repeated failure', () => {
  for (const lastStatus of [0, 1]) {
    const calls = [],
      evidence = [];
    const status = runBrowserTests({
      args: ['--shard=1/2'],
      remove() {},
      log() {},
      preserveEvidence() {
        evidence.push('save');
        return () => evidence.push('restore');
      },
      execute(_node, args) {
        calls.push(args);
        return calls.length === 1
          ? { status: 0 }
          : calls.length === 2
            ? { status: 1, stderr: disconnected }
            : { status: lastStatus, stderr: lastStatus ? disconnected : '' };
      },
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1], calls[2]);
    assert.ok(calls[2].includes('--shard=1/2'));
    assert.deepEqual(evidence, ['save', 'restore']);
    assert.equal(status, lastStatus);
  }
});

// Use the installed Vitest sequencer and actual fixture discovery, without
// starting a browser. Static YAML checks alone cannot prove shard coverage.
test(
  'both native browser shards cover every discovered specification exactly once',
  { timeout: 30000 },
  async () => {
    const root = fileURLToPath(new URL('../', import.meta.url)).replace(
      /\/$/,
      '',
    );
    const expected = [],
      actual = [];
    for (const run of browserRunPlan(['--shard=1/2'])) {
      const ctx = await createVitest('test', {
        root,
        project: [run.project],
        watch: false,
        api: false,
      });
      try {
        const specs = await ctx.globTestSpecifications();
        assert.ok(specs.length > 0);
        assert.deepEqual(
          [...new Set(specs.map((spec) => spec.project.name))],
          [run.project],
          'Each process must select exactly one engine',
        );
        const project = specs[0].project;
        if (run.project.includes('chromium'))
          assert.equal(project.config.maxWorkers, 2);
        else assert.equal(project.config.browser.fileParallelism, false);
        const key = (spec) => `${spec.project.name}:${spec.moduleId}`;
        expected.push(...specs.map(key));
        for (const index of [1, 2]) {
          const shard = await new BaseSequencer({
            config: { ...ctx.config, shard: { index, count: 2 } },
          }).shard(specs);
          assert.ok(shard.length > 0);
          actual.push(...shard.map(key));
        }
      } finally {
        await ctx.close();
      }
    }
    assert.equal(new Set(expected).size, expected.length);
    assert.equal(new Set(actual).size, actual.length, 'Shards overlap');
    assert.deepEqual(
      actual.sort(),
      expected.sort(),
      'An engine or browser specification was omitted',
    );
    console.log(
      `Verified ${expected.length} specifications across two isolated engines and two shards`,
    );
  },
);

test('runner retains both engines, shard arguments, evidence and a failing exit code', () => {
  for (const statuses of [
    [0, 0],
    [1, 0],
    [0, 1],
  ]) {
    const calls = [],
      removed = [];
    const status = runBrowserTests({
      args: ['--shard=2/2'],
      remove: (...args) => removed.push(args),
      log() {},
      execute: (node, args) => {
        calls.push(args);
        return { status: statuses[calls.length - 1] };
      },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('browser (chromium)'));
    assert.ok(calls[1].includes('browser (webkit)'));
    for (const call of calls) assert.ok(call.includes('--shard=2/2'));
    assert.equal(
      removed.length,
      1,
      'Do not erase Chromium evidence before WebKit',
    );
    assert.equal(status, statuses.some(Boolean) ? 1 : 0);
  }
  assert.throws(
    () => browserRunPlan(['--project=browser']),
    /Engine selection/,
  );
  assert.equal(
    runBrowserTests({
      remove() {},
      log() {},
      execute: () => ({ signal: 'SIGTERM', status: null }),
    }),
    1,
  );
});
