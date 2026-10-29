import { installBundle } from './codex-cli.mjs';
try {
  installBundle(
    new URL('../codex-runtime', import.meta.url).pathname,
    '/managed-home',
    {
      releaseId: process.argv[2],
      manifestSha256: process.argv[3],
    },
  );
} catch {
  // Do not leak host paths, environment, credentials or arbitrary filesystem errors.
  console.error('codexRuntimeInstallationFailed');
  process.exitCode = 1;
}
