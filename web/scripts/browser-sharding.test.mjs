import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BaseSequencer, createVitest } from 'vitest/node';
import {
  browserRunPlan,
  runBrowserTests,
  webkitSpecifications,
  withoutShard,
} from './run-browser-tests.mjs';

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
          if (run.project.includes('webkit')) {
            const files = await webkitSpecifications([`--shard=${index}/2`]);
            assert.deepEqual(
              files,
              shard.map((spec) => spec.moduleId).sort(),
              'Isolated runner must use exactly the native shard',
            );
          }
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

test('runner retains every specification, evidence and a failing exit code without retry', async () => {
  for (const statuses of [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]) {
    const calls = [],
      removed = [];
    const status = await runBrowserTests({
      args: ['--shard=2/2', '--testNamePattern', 'example'],
      discover: async () => [
        '/web/src/one.browser.tsx',
        '/web/src/two.browser.tsx',
      ],
      remove: (...args) => removed.push(args),
      log() {},
      execute: (node, args, options) => {
        calls.push({ args, options });
        return { status: statuses[calls.length - 1] };
      },
    });
    assert.equal(calls.length, 3);
    assert.ok(calls[0].args.includes('browser (chromium)'));
    assert.ok(calls[0].args.includes('--shard=2/2'));
    assert.deepEqual(
      calls.slice(1).map((call) => call.options.env.MERGERON_WEBKIT_SPEC),
      ['/web/src/one.browser.tsx', '/web/src/two.browser.tsx'],
    );
    for (const call of calls.slice(1)) {
      assert.ok(call.args.includes('browser (webkit)'));
      assert.equal(
        call.args.some((value) => value.startsWith('--shard')),
        false,
        'Shard is applied once during discovery',
      );
      assert.ok(call.args.includes('--testNamePattern'));
      assert.ok(call.args.includes('example'));
    }
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
    await runBrowserTests({
      remove() {},
      log() {},
      execute: () => ({ signal: 'SIGTERM', status: null }),
    }),
    1,
  );
});

test('empty or duplicate discovery fails closed without running an incomplete WebKit suite', async () => {
  for (const files of [
    [],
    ['/web/src/a.browser.tsx', '/web/src/a.browser.tsx'],
  ]) {
    const calls = [];
    assert.equal(
      await runBrowserTests({
        discover: async () => files,
        remove() {},
        log() {},
        execute: (_node, args) => {
          calls.push(args);
          return { status: 0 };
        },
      }),
      1,
    );
    assert.equal(calls.length, 1); // Chromium ran, WebKit discovery did not authorize a partial pass.
  }
  assert.deepEqual(
    withoutShard(['--shard', '1/2', '--testNamePattern', 'same']),
    ['--testNamePattern', 'same'],
  );
});

test('an isolated child can discover only its assigned file', async () => {
  const files = await webkitSpecifications(['--shard=1/2']);
  const previous = process.env.MERGERON_WEBKIT_SPEC;
  process.env.MERGERON_WEBKIT_SPEC = files[0];
  const root = fileURLToPath(new URL('../', import.meta.url));
  let ctx;
  try {
    ctx = await createVitest('test', {
      root,
      project: ['browser (webkit)'],
      watch: false,
      api: false,
    });
    const specs = await ctx.globTestSpecifications();
    assert.deepEqual(
      specs.map((s) => s.moduleId),
      [files[0]],
    );
  } finally {
    if (ctx) await ctx.close();
    if (previous === undefined) delete process.env.MERGERON_WEBKIT_SPEC;
    else process.env.MERGERON_WEBKIT_SPEC = previous;
  }
});
