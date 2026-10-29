const runtime = require('../runtime/managed-cli.cjs');
try {
  const home = process.argv[2];
  if (
    process.argv[3] === 'update' &&
    (runtime.selection(home).protection || runtime.legacyCustom(home))
  )
    throw new Error('Use the validated CLI update in Mergeron administration');
  const executable = runtime.selected(home);
  if (executable) process.stdout.write(executable);
} catch {
  console.error(
    'Protected Codex CLI could not be verified. Use Mergeron administration; no legacy fallback was started.',
  );
  process.exitCode = 78;
}
