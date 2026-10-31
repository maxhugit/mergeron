import { probeManager } from './health-probe.mjs';

const result = await probeManager({
  socketPath:
    process.env.MERGERON_MANAGER_SOCKET ?? '/run/mergeron-manager/manager.sock',
});
// Only fixed reason codes: no response bodies, paths, credentials or headers.
if (!result.healthy) console.error(result.reason);
process.exit(result.healthy ? 0 : 1);
