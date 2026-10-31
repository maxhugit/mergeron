// Run explicitly in the preview console. Activation codes never enter server logs.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { configuration, backendEnvironment, repository } from './config.mjs';

const config = configuration();
const result = spawnSync(
  process.execPath,
  [join(repository, 'scripts/setup-admin.cjs'), ...process.argv.slice(2)],
  {
    cwd: config.dataDirectory,
    env: backendEnvironment(config),
    stdio: 'inherit',
  },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
