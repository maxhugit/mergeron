// Resolve the provider's own locked Playwright version with pnpm's strict layout.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const provider = createRequire(require.resolve('@vitest/browser-playwright'));
const cli = join(
  dirname(provider.resolve('playwright/package.json')),
  'cli.js',
);
execFileSync(process.execPath, [cli, 'install', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
