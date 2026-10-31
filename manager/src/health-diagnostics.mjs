import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';

export async function reportHealthDelay(
  delayMs,
  {
    read = readFile,
    log = console.warn,
    rss = () => process.memoryUsage().rss,
  } = {},
) {
  if (!Number.isFinite(delayMs) || delayMs < 1000) return;
  const fields = {};
  for (const [file, keys] of [
    [
      'cpu.stat',
      {
        nr_throttled: 'cpuThrottledPeriods',
        throttled_usec: 'cpuThrottledMicros',
      },
    ],
    ['memory.events', { max: 'memoryLimitEvents', oom_kill: 'oomKills' }],
    ['memory.current', { value: 'memoryCurrentBytes' }],
  ]) {
    try {
      const raw = await read(`/sys/fs/cgroup/${file}`, 'utf8');
      const entries =
        file === 'memory.current'
          ? [['value', raw.trim()]]
          : raw
              .trim()
              .split('\n')
              .map((line) => line.split(/\s+/));
      for (const [key, value] of entries) {
        const number = Number(value);
        if (
          Object.hasOwn(keys, key) &&
          Number.isSafeInteger(number) &&
          number >= 0
        )
          fields[keys[key]] = number;
      }
    } catch {
      // Non-Linux or cgroup v1: diagnostics must never affect availability.
    }
  }
  log({
    event: 'managerEventLoopDelayed',
    eventLoopDelayMs: Math.round(delayMs),
    rssBytes: rss(),
    ...fields,
  });
}

export function startHealthDiagnostics({
  histogram = monitorEventLoopDelay({ resolution: 100 }),
  intervalMs = 20_000,
  report = reportHealthDelay,
} = {}) {
  histogram.enable();
  let reporting = false;
  const timer = setInterval(() => {
    const delayMs = histogram.max / 1e6;
    histogram.reset();
    if (reporting || delayMs < 1000) return;
    reporting = true;
    void Promise.resolve()
      .then(() => report(delayMs))
      .catch(() => {})
      .finally(() => {
        reporting = false;
      });
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
