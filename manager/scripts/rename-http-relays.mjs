/** Explicit host-side rename: keep existing connections and container protections. */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DockerClient } from '../src/docker-client.mjs';
import { installGateways, gatewayRouting } from './install-update-gateway.mjs';

async function verifyPublicRouting(hostname, marker) {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`https://${hostname}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
      if (
        response.status < 400 &&
        response.headers.get('x-mergeron-relay-rename') === marker
      )
        return;
    } catch {
      /* Wait for the proxy's atomic configuration reload. */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    'Relay routing not acknowledged; inspect proxy before retrying',
  );
}
export async function renameHttpRelays(
  config,
  docker = new DockerClient(),
  verify = verifyPublicRouting,
) {
  if (!config.proxyDirectory) throw new Error('Proxy directory required');
  // Reuse the provisioner's profile/image validation, preserving legacy names.
  config = await installGateways(config, docker);
  const path = join(
    resolve(config.proxyDirectory),
    `${config.stack}-continuous.yml`,
  );
  const original = await readFile(path, 'utf8');
  const slots = [];
  for (const [index, suffix] of ['a', 'b'].entries()) {
    const name = `${config.stack}-acces-web-${index + 1}`;
    const legacy = `${config.stack}-update-gateway-${suffix}`;
    const containers = await docker.listContainers();
    const preferred = containers.find((c) => c.Names.includes('/' + name));
    const old = containers.find((c) => c.Names.includes('/' + legacy));
    if (preferred && old)
      throw new Error('Relay name conflict; no rename performed');
    const current = await docker.inspectContainer((preferred ?? old).Id);
    const ip = current.NetworkSettings?.Networks?.[config.network]?.IPAddress;
    if (
      !isIP(ip ?? '') ||
      !current.State.Running ||
      current.State.Health?.Status !== 'healthy'
    )
      throw new Error('Healthy relay address required');
    slots.push({ id: current.Id, before: preferred ? name : legacy, name, ip });
  }
  if (slots.every((s) => s.before === s.name)) return;
  const marker = randomUUID(); // Public, temporary acknowledgement, never an access token.
  const write = async (routing) => {
    await writeFile(path + '.tmp', JSON.stringify(routing, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(path + '.tmp', path);
  };
  const marked = (names, value) => {
    const routing = gatewayRouting(config, names);
    routing.http.middlewares[
      `${config.stack}-continuous-security`
    ].headers.customResponseHeaders = {
      ...routing.http.middlewares[`${config.stack}-continuous-security`].headers
        .customResponseHeaders,
      'X-Mergeron-Relay-Rename': value,
    };
    return routing;
  };
  const addresses = slots.map((s) => (isIP(s.ip) === 6 ? `[${s.ip}]` : s.ip));
  const changed = [];
  try {
    // Routing by unchanged IPs makes Docker DNS name changes irrelevant.
    await write(marked(addresses, marker));
    await verify(config.hostname, marker);
    for (const slot of slots) {
      if (slot.before === slot.name) continue;
      await docker.renameContainer(slot.id, slot.name);
      changed.push(slot);
    }
    await write(
      marked(
        slots.map((s) => s.name),
        marker + '-named',
      ),
    );
    await verify(config.hostname, marker + '-named');
    await write(gatewayRouting(config));
    await verify(config.hostname, null);
  } catch (error) {
    if (changed.length) {
      await write(marked(addresses, marker + '-rollback'));
      await verify(config.hostname, marker + '-rollback');
      for (const slot of changed.reverse())
        await docker.renameContainer(slot.id, slot.before);
    }
    await writeFile(path + '.tmp', original, { mode: 0o600 });
    await rename(path + '.tmp', path);
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const index = arg.indexOf('=');
      if (!arg.startsWith('--') || index < 0)
        throw new Error('Use --key=value');
      return [arg.slice(2, index), arg.slice(index + 1)];
    }),
  );
  await renameHttpRelays({
    stack: options.stack,
    hostname: options.hostname,
    image: options.image,
    stateRoot: options['state-root'],
    network: options.network,
    proxyDirectory: options['proxy-directory'],
  });
}
