/** Docker healthcheck in the trusted relay, never in the networkless Manager.
 * No body, redirect, diagnostic or transport capability is emitted.
 */
import { probePreview } from './preview-health.mjs';

const host = process.env.MERGERON_PREVIEW_PUBLIC_HOST ?? '';
const separator = host.indexOf('.');
const result = await probePreview({
  // Old relays used the run ID as their public host; new ones use a stable ID.
  runId: process.env.MERGERON_PREVIEW_RUN_ID ?? host.slice(0, separator),
  publicHost: host,
  domain: host.slice(separator + 1),
  path: process.env.MERGERON_PREVIEW_HEALTH_PATH ?? '/',
  token: process.env.MERGERON_PREVIEW_TRANSPORT_TOKEN,
});
console.log(JSON.stringify(result));
process.exitCode = result.ready ? 0 : 1;
