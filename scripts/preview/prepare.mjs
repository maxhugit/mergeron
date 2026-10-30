import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { repository } from './config.mjs';

// Keep caches and proxy settings supplied by the executor; never write shims in /usr/local.
const { packageManager } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const env = {
  ...process.env,
  NODE_ENV: 'development',
  COREPACK_ENABLE_AUTO_PIN: '0',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
};
function run(args, cwd = repository) {
  const result = spawnSync('corepack', [packageManager, ...args], {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Preview preparation failed (exit ${result.status ?? result.signal})`,
    );
}
try {
  if (env.PNPM_HOME) {
    const shims = spawnSync(
      'corepack',
      ['enable', '--install-directory', env.PNPM_HOME],
      { env, stdio: 'inherit' },
    );
    if (shims.error || shims.status !== 0)
      throw new Error('Unable to enable Corepack shims in PNPM_HOME');
    env.PATH = `${env.PNPM_HOME}${delimiter}${env.PATH ?? ''}`;
  }
  if (!env.npm_config_nodedir && existsSync('/usr/local/include/node/node.h'))
    env.npm_config_nodedir = '/usr/local';
  if (process.argv[2] === 'install') {
    run(['install', '--frozen-lockfile', '--reporter=ndjson']);
    run(['--dir', 'web', 'install', '--frozen-lockfile', '--reporter=ndjson']);
  } else if (process.argv[2] === 'build') {
    run(['build']);
    const result = spawnSync(
      process.execPath,
      ['web/scripts/package-browser-extension.mjs'],
      { cwd: repository, env, stdio: 'inherit' },
    );
    if (result.error || result.status !== 0)
      throw new Error('Browser extension packaging failed');
  } else
    throw new Error('Usage: node scripts/preview/prepare.mjs install|build');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
