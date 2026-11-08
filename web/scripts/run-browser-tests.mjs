/** Run each engine in a fresh Vitest process; share neither its runner nor browser sessions. */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

export function browserRunPlan(args = []) {
  // Engine selection belongs to this runner. Shard/file filters are preserved
  // identically for both engines; they cannot accidentally select another engine.
  if (args.some((arg) => /^--(?:project|browser)(?:[.=]|$)/.test(arg)))
    throw new Error(
      'Engine selection is fixed to Chromium then WebKit. Use Vitest directly for a single-engine diagnostic.',
    );
  return ['chromium', 'webkit'].map((engine) => ({
    project: `browser (${engine})`,
    args: ['run', '--project', `browser (${engine})`, ...args],
  }));
}

export function runBrowserTests({
  args = [],
  execute = spawnSync,
  remove = rmSync,
  log = console.log,
} = {}) {
  const plan = browserRunPlan(args);
  // Clean once, not between engines: retain evidence from both, even on failure.
  remove(join(root, '.vitest-screenshots'), { recursive: true, force: true });
  let failed = false;
  for (const run of plan) {
    log(`\nBrowser checks: ${run.project}`);
    const result = execute(process.execPath, [cli, ...run.args], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.error) log(result.error.message);
    if (result.signal) return 1;
    // Still run the other engine after a failed assertion or runner error.
    if (result.error || result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = runBrowserTests({ args: process.argv.slice(2) });
