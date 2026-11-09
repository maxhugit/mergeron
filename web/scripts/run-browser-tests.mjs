/** Run each engine in a fresh Vitest process; share neither its runner nor browser sessions. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

export function retryableWebkitDisconnect(result) {
  if (result.error || result.signal || result.status === 0) return false;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(
    new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'),
    '',
  );
  return (
    output.includes(
      '[vitest] Browser connection was closed while running tests',
    ) &&
    !/(AssertionError|\bFAIL\s|Test timed out|Tests\s+[1-9]\d*\s+failed|Test Files\s+[1-9]\d*\s+failed)/.test(
      output,
    )
  );
}

function preserveBrowserEvidence() {
  const source = join(root, '.vitest-screenshots');
  const temporary = mkdtempSync(join(tmpdir(), 'mergeron-browser-evidence-'));
  if (existsSync(source)) cpSync(source, temporary, { recursive: true });
  return () => {
    try {
      cpSync(temporary, join(source, 'webkit-disconnect-attempt-1'), {
        recursive: true,
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  };
}

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
  preserveEvidence = preserveBrowserEvidence,
} = {}) {
  const plan = browserRunPlan(args);
  // Clean once, not between engines: retain evidence from both, even on failure.
  remove(join(root, '.vitest-screenshots'), { recursive: true, force: true });
  let failed = false;
  for (const run of plan) {
    log(`\nBrowser checks: ${run.project}`);
    const attempt = () => {
      const result = execute(process.execPath, [cli, ...run.args], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.stdout) log(String(result.stdout));
      if (result.stderr) log(String(result.stderr));
      return result;
    };
    let result = attempt();
    if (
      run.project === 'browser (webkit)' &&
      retryableWebkitDisconnect(result)
    ) {
      log(
        'WebKit runner disconnected without an assertion failure; retrying this complete engine/shard once in a fresh process. First-attempt evidence is retained.',
      );
      const restoreEvidence = preserveEvidence();
      try {
        result = attempt();
      } finally {
        restoreEvidence();
      }
    }
    if (result.error) log(result.error.message);
    if (result.signal) return 1;
    // Still run the other engine after a failed assertion or runner error.
    if (result.error || result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = runBrowserTests({ args: process.argv.slice(2) });
