/** Host-side provisioning: no access to Docker or private state is granted to the gateways. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerClient } from '../src/docker-client.mjs';

export function gatewaySpecification({
  stack,
  hostname,
  image,
  stateRoot,
  network,
}) {
  if (
    !/^mergeron(?:-[a-z0-9-]+)?$/.test(stack) ||
    !/^[a-z0-9.-]+$/i.test(hostname) ||
    !/^ghcr.io\/maxhugit\/mergeron-manager@sha256:[a-f0-9]{64}$/.test(image)
  )
    throw new Error('Invalid gateway configuration');
  if (
    !stateRoot.startsWith('/') ||
    /[:\0]/.test(stateRoot) ||
    stateRoot.split('/').includes('..') ||
    !/^[a-z0-9_-]+$/i.test(network)
  )
    throw new Error('Invalid gateway paths');
  return {
    Image: image,
    User: '65532:65532',
    Entrypoint: ['/nodejs/bin/node', 'src/update-monitor-gateway.mjs'],
    Healthcheck: {
      Test: [
        'CMD',
        '/nodejs/bin/node',
        '--input-type=module',
        '-e',
        `import http from 'node:http';const r=http.get({host:'127.0.0.1',port:8080,path:'/_gateway-health',headers:{Host:${JSON.stringify(hostname)}}},s=>{s.resume();process.exitCode=s.statusCode===200?0:1});r.setTimeout(2000,()=>r.destroy());r.on('error',()=>process.exitCode=1);`,
      ],
      Interval: 2000000000,
      Timeout: 3000000000,
      Retries: 3,
      StartPeriod: 2000000000,
    },
    Env: [
      `MERGERON_PUBLIC_HOST=${hostname}`,
      `MERGERON_GATEWAY_UPSTREAM=http://${stack}-ingress:8080`,
    ],
    Labels: {
      'io.mergeron.stack': stack,
      'io.mergeron.component': 'updateGateway',
      'io.mergeron.managed': 'true',
    },
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: network,
      Binds: [`${stateRoot}/manager-state/maintenance:/monitor:ro`],
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 64 * 1024 * 1024,
      PidsLimit: 64,
    },
    NetworkingConfig: { EndpointsConfig: { [network]: {} } },
  };
}
export function gatewayRouting({ stack, hostname }) {
  return {
    http: {
      routers: {
        [`${stack}-continuous`]: {
          rule: `Host(\`${hostname}\`)`,
          priority: 150,
          entryPoints: ['websecure'],
          tls: {},
          service: `${stack}-continuous`,
          middlewares: [`${stack}-continuous-security`],
        },
        [`${stack}-monitor`]: {
          rule: `Host(\`${hostname}\`) && PathPrefix(\`/_mergeron-update\`)`,
          priority: 300,
          entryPoints: ['websecure'],
          tls: {},
          service: `${stack}-continuous`,
        },
      },
      middlewares: {
        [`${stack}-continuous-security`]: {
          headers: {
            contentTypeNosniff: true,
            frameDeny: true,
            referrerPolicy: 'no-referrer',
            stsSeconds: 31536000,
            stsIncludeSubdomains: true,
          },
        },
      },
      services: {
        [`${stack}-continuous`]: {
          loadBalancer: {
            passHostHeader: true,
            healthCheck: {
              path: '/_gateway-health',
              hostname,
              interval: '2s',
              timeout: '1s',
            },
            servers: ['a', 'b'].map((slot) => ({
              url: `http://${stack}-update-gateway-${slot}:8080`,
            })),
          },
        },
      },
    },
  };
}
export async function installGateways(config, docker = new DockerClient()) {
  const spec = gatewaySpecification(config);
  const directory = join(config.stateRoot, 'manager-state', 'maintenance');
  await mkdir(directory, { recursive: true, mode: 0o755 });
  for (const slot of ['a', 'b']) {
    const name = `${config.stack}-update-gateway-${slot}`;
    const existing = (await docker.listContainers()).find((c) =>
      c.Names.includes('/' + name),
    );
    if (existing) {
      const old = await docker.inspectContainer(existing.Id);
      if (
        old.Config.Labels?.['io.mergeron.component'] !== 'updateGateway' ||
        old.Config.Labels?.['io.mergeron.stack'] !== config.stack
      )
        throw new Error('Gateway name conflict');
      if (old.Config.Image === config.image && old.State.Running) continue;
      // Replace one replica at a time. Routing is installed only after both answer HTTP.
      await docker.stopContainer(existing.Id);
      await docker.removeContainer(existing.Id);
    }
    const created = await docker.createContainer(name, spec);
    await docker.startContainer(created.Id);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const inspection = await docker.inspectContainer(created.Id);
      // Docker healthcheck below is an actual HTTP request, not process existence.
      if (inspection.State.Health?.Status === 'healthy') {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready)
      throw new Error('Gateway HTTP health check failed; routing not changed');
  }
  if (config.proxyDirectory) {
    const path = join(
      resolve(config.proxyDirectory),
      `${config.stack}-continuous.yml`,
    );
    const text = JSON.stringify(gatewayRouting(config), null, 2) + '\n';
    try {
      const old = await readFile(path, 'utf8');
      await writeFile(path + '.previous', old, { mode: 0o600 });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeFile(path + '.tmp', text, { mode: 0o600 });
    await rename(path + '.tmp', path);
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
  await installGateways({
    stack: options.stack,
    hostname: options.hostname,
    image: options.image,
    stateRoot: options['state-root'],
    network: options.network ?? 'mergeron-proxy',
    proxyDirectory: options['proxy-directory'],
  });
}
