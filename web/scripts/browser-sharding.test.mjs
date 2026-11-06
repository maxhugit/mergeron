import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BaseSequencer, createVitest } from 'vitest/node';

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
    const ctx = await createVitest('test', {
      root,
      project: ['browser'],
      watch: false,
      api: false,
    });
    try {
      const chromium = ctx.projects.find((p) => p.name.includes('chromium'));
      const webkit = ctx.projects.find((p) => p.name.includes('webkit'));
      assert.equal(chromium.config.maxWorkers, 2);
      assert.equal(webkit.config.browser.fileParallelism, false);
      const specs = await ctx.globTestSpecifications();
      assert.ok(specs.length > 0);
      const key = (spec) => `${spec.project.name}:${spec.moduleId}`;
      const expected = specs.map(key).sort();
      assert.equal(new Set(expected).size, expected.length);
      const shards = await Promise.all(
        [1, 2].map((index) =>
          new BaseSequencer({
            config: { ...ctx.config, shard: { index, count: 2 } },
          }).shard(specs),
        ),
      );
      for (const shard of shards) {
        assert.ok(shard.length > 0);
        assert.ok(shard.some((spec) => spec.project.name.includes('chromium')));
        assert.ok(shard.some((spec) => spec.project.name.includes('webkit')));
      }
      const actual = shards.flat().map(key);
      assert.equal(new Set(actual).size, actual.length, 'Shards overlap');
      assert.deepEqual(
        actual.sort(),
        expected,
        'A browser specification was omitted',
      );
      console.log(
        `Verified ${specs.length} browser specifications: ${shards.map((s) => s.length).join(' + ')}`,
      );
    } finally {
      await ctx.close();
    }
  },
);
