import { existsSync } from 'node:fs';

export const AGENT_ENVIRONMENT_LAUNCHER =
  '/usr/local/bin/mergeron-agent-environment';

/** Local development stays unchanged; the image initializes caches inside bwrap. */
export function agentEnvironmentCommand(
  binary: string,
  args: string[],
  available = existsSync(AGENT_ENVIRONMENT_LAUNCHER),
): { binary: string; args: string[] } {
  return available
    ? { binary: AGENT_ENVIRONMENT_LAUNCHER, args: [binary, ...args] }
    : { binary, args };
}
