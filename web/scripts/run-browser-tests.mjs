/** Fresh Chromium runner and one fresh WebKit runner per specification; retry only pure transport disconnects once. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BaseSequencer, createVitest, parseCLI } from 'vitest/node';

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

/** Discover and shard with Vitest itself; never maintain a second fixture list. */
export async function webkitSpecifications(args) {
  const { filter, options } = parseCLI(['vitest', 'run', ...args]);
  const ctx = await createVitest('test', {
    ...options,
    root,
    project: ['browser (webkit)'],
    watch: false,
    api: false,
  });
  try {
    const specs = await ctx.globTestSpecifications(filter);
    const selected = ctx.config.shard
      ? await new BaseSequencer(ctx).shard(specs)
      : specs;
    return selected.map((spec) => spec.moduleId).sort();
  } finally {
    await ctx.close();
  }
}

export function withoutShard(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shard') {
      i++;
      continue;
    }
    if (!args[i].startsWith('--shard=')) result.push(args[i]);
  }
  return result;
}

export async function runBrowserTests({
  args = [],
  execute = spawnSync,
  discover = webkitSpecifications,
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
    const files =
      run.project === 'browser (webkit)' ? await discover(args) : [null];
    if (!files.length || new Set(files).size !== files.length) {
      log(
        'Browser discovery returned an empty or duplicate specification list.',
      );
      failed = true;
      continue;
    }
    for (const [index, file] of files.entries()) {
      if (file)
        log(
          `WebKit isolated specification ${index + 1}/${files.length}: ${file}`,
        );
      const attempt = () => {
        const result = execute(
          process.execPath,
          [cli, ...(file ? withoutShard(run.args) : run.args)],
          {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, MERGERON_WEBKIT_SPEC: file ?? '' },
          },
        );
        if (result.stdout) log(String(result.stdout));
        if (result.stderr) log(String(result.stderr));
        return result;
      };
      let result = attempt();
      if (file && retryableWebkitDisconnect(result)) {
        log(
          'WebKit transport disconnected without assertion failure; retrying only this isolated specification once. First-attempt evidence is retained.',
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
      // Assertions, crashes and a repeated transport disconnect remain failures.
      if (result.error || result.status !== 0) failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runBrowserTests({ args: process.argv.slice(2) });
