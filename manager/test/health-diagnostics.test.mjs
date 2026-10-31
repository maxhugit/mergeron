import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reportHealthDelay,
  startHealthDiagnostics,
} from '../src/health-diagnostics.mjs';

test('only a delayed event loop emits bounded numeric diagnostics, never raw cgroup contents', async () => {
  const output = [];
  let reads = 0;
  const options = {
    read: async (path) => {
      reads++;
      return path.endsWith('cpu.stat')
        ? 'nr_throttled 2\nthrottled_usec 45\nprivate secret-never-print\nconstructor 1\n__proto__ 1\n'
        : path.endsWith('memory.events')
          ? 'max 4\noom_kill 0\n'
          : '12345\n';
    },
    log: (value) => output.push(value),
    rss: () => 999,
  };
  await reportHealthDelay(999, options);
  assert.equal(reads, 0);
  await reportHealthDelay(3200.9, options);
  assert.deepEqual(output, [
    {
      event: 'managerEventLoopDelayed',
      eventLoopDelayMs: 3201,
      rssBytes: 999,
      cpuThrottledPeriods: 2,
      cpuThrottledMicros: 45,
      memoryLimitEvents: 4,
      oomKills: 0,
      memoryCurrentBytes: 12345,
    },
  ]);
  output.length = 0;
  await reportHealthDelay(2000, {
    ...options,
    read: async () => {
      throw Error('private path');
    },
  });
  assert.deepEqual(output, [
    { event: 'managerEventLoopDelayed', eventLoopDelayMs: 2000, rssBytes: 999 },
  ]);
});

test('diagnostic reports do not overlap, failures are contained and monitoring can stop', async () => {
  let calls = 0;
  let release;
  let disabled = false;
  const histogram = {
    max: 3e9,
    enable() {},
    disable() {
      disabled = true;
    },
    reset() {},
  };
  const stop = startHealthDiagnostics({
    histogram,
    intervalMs: 10,
    report: async () => {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
      throw Error('contained');
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 2);
    release();
  } finally {
    stop();
  }
  assert.equal(disabled, true);
});
