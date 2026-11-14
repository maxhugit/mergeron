import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

export const AGENT_ENVIRONMENT_LAUNCHER =
  '/usr/local/bin/mergeron-agent-environment';

/** Source-only installations skip the cache wrapper; the image initializes caches inside bwrap. */
export function agentEnvironmentCommand(
  binary: string,
  args: string[],
  available = existsSync(AGENT_ENVIRONMENT_LAUNCHER),
): { binary: string; args: string[] } {
  return available
    ? { binary: AGENT_ENVIRONMENT_LAUNCHER, args: [binary, ...args] }
    : { binary, args };
}

/** Pin child processes to the server's installed Node, independently of its production mode. */
export function agentChildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    MERGERON_AGENT_NODE_BINARY: process.execPath,
    PATH: [
      dirname(process.execPath),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      env.PATH,
    ]
      .filter(Boolean)
      .join(':'),
    NODE_ENV: env.MERGERON_AGENT_NODE_ENV ?? 'development',
  };
}
