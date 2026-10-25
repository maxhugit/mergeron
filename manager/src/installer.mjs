import { chown, mkdir, open, readFile, lstat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectInventory } from './inventory.mjs';
import {
  hostLabels,
  readHostIntegration,
  readAppdataRoot,
} from './integrations/host-platform.mjs';

const MANAGED_LABELS = {
  'io.mergeron.managed': 'true',
};
const INSTALL_CONFIRMATION = 'INSTALL';

/** Same reviewed profile as Compose; Docker API expects inline JSON, not a path. */
function documentSeccompProfile() {
  let source;
  try {
    source = readFileSync(
      new URL('../seccomp-bwrap.json', import.meta.url),
      'utf8',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = readFileSync(
      new URL('../../deployment/config/seccomp-bwrap.json', import.meta.url),
      'utf8',
    );
  }
  const profile = JSON.parse(source);
  if (profile.defaultAction !== 'SCMP_ACT_ERRNO')
    throw new Error('Invalid document seccomp profile');
  return `seccomp=${JSON.stringify(profile)}`;
}

function absoluteSafePath(value, name) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/')
    throw new Error(`${name} is invalid`);
  if (
    value.includes('\0') ||
    value.includes(':') ||
    value.split('/').includes('..')
  )
    throw new Error(`${name} is invalid`);
  return value.replace(/\/$/, '');
}

function privateIpv4Cidr(value) {
  const [address, prefix, extra] = String(value).split('/');
  if (extra !== undefined || !/^\d+$/.test(prefix ?? '')) return false;
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  const privateAddress =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  const prefixNumber = Number(prefix);
  return privateAddress && prefixNumber >= 8 && prefixNumber <= 30;
}

function webUrl(value, name) {
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${name} is invalid`);
  }
}

function imageRepository(reference) {
  const withoutDigest = String(reference ?? '').split('@')[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

export function readInstallConfiguration(manifest, env = process.env) {
  const production = manifest.environment === 'production';
  const defaultRoot = `/srv/${manifest.stack}/state`;
  const stateRoot = absoluteSafePath(
    env.MERGERON_STATE_ROOT ?? defaultRoot,
    'MERGERON_STATE_ROOT',
  );
  const configuration = {
    stackPrefix: manifest.stack,
    enabled: env.MERGERON_INSTALL_ENABLED === 'true',
    stateRoot,
    hostStatePath: absoluteSafePath(
      env.MERGERON_MANAGER_HOST_STATE ?? '/host-state',
      'MERGERON_MANAGER_HOST_STATE',
    ),
    defaultsPath:
      env.MERGERON_MANAGER_DEFAULT_CONFIG ??
      '/opt/mergeron-manager/default-config',
    appdataRoot: absoluteSafePath(
      readAppdataRoot(env, stateRoot),
      'MERGERON_APPDATA_ROOT',
    ),
    authMode: env.MERGERON_AUTH_MODE ?? 'native',
    hostIntegration: readHostIntegration(env),
    adminSubnet:
      env.MERGERON_ADMIN_SUBNET ??
      (production ? '172.30.44.0/28' : '172.30.44.16/28'),
    publicUrl: webUrl(
      env.MERGERON_WEBUI_URL ??
        (production
          ? 'https://mergeron.example.com'
          : 'https://mergeron-dev.example.com'),
      'MERGERON_WEBUI_URL',
    ),
    iconUrl: webUrl(
      env.MERGERON_ICON_URL?.trim() ||
        `https://raw.githubusercontent.com/maxhugit/mergeron/main/web/public/${production ? 'pwa-icon-192.png' : 'pwa-dev-icon-192.png'}`,
      'MERGERON_ICON_URL',
    ),
    images: {
      application:
        env.MERGERON_APP_IMAGE ??
        `ghcr.io/maxhugit/mergeron:${production ? 'latest' : 'edge'}`,
      ingress: env.MERGERON_INGRESS_IMAGE ?? 'nginx:stable',
      egress: env.MERGERON_EGRESS_IMAGE ?? 'ubuntu/squid:latest',
    },
  };
  if (!['authentik', 'native'].includes(configuration.authMode))
    throw new Error('MERGERON_AUTH_MODE is invalid');
  if (!privateIpv4Cidr(configuration.adminSubnet))
    throw new Error('MERGERON_ADMIN_SUBNET is invalid');
  for (const component of manifest.components) {
    const repository = imageRepository(configuration.images[component.id]);
    if (!component.allowedImageRepositories.includes(repository))
      throw new Error(`${component.id}:imageRepositoryNotAllowed`);
  }
  return configuration;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function networkCompatibility(network, desired, configuration) {
  if (network.Driver !== 'bridge') return 'driverMismatch';
  if (Boolean(network.Internal) !== Boolean(desired.internal))
    return 'internalModeMismatch';
  if (desired.subnetFromConfiguration) {
    const subnets = (network.IPAM?.Config ?? []).map((item) => item.Subnet);
    if (!subnets.includes(configuration.adminSubnet)) return 'subnetMismatch';
  }
  return null;
}

const PERSISTENT_DIRECTORIES = [
  'home',
  'workspace',
  'logs',
  'ssh',
  'manager-run',
  'manager-state',
  'config',
  'appdata',
];

async function persistentStatePlan(configuration) {
  const actions = [];
  const blockers = [];
  for (const directory of PERSISTENT_DIRECTORIES) {
    const path = join(configuration.hostStatePath, directory);
    try {
      const value = await lstat(path);
      if (!value.isDirectory() || value.isSymbolicLink())
        blockers.push(`persistent:${directory}:notDirectory`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      actions.push({ type: 'createDirectory', path: directory });
    }
  }
  for (const file of [
    'backend-token.txt',
    'backend-token-nginx.txt',
    'openai-api-key.txt',
    'config/nginx.conf.template',
    'config/squid.conf',
  ]) {
    try {
      const value = await lstat(join(configuration.hostStatePath, file));
      if (!value.isFile() || value.isSymbolicLink())
        blockers.push(`persistent:${file}:notRegularFile`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      actions.push({ type: 'createFile', path: file });
    }
  }
  const token = join(configuration.hostStatePath, 'backend-token.txt');
  const nginxToken = join(
    configuration.hostStatePath,
    'backend-token-nginx.txt',
  );
  const regularFile = async (path) => {
    try {
      const value = await lstat(path);
      return value.isFile() && !value.isSymbolicLink();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  if ((await regularFile(token)) && (await regularFile(nginxToken))) {
    const values = await Promise.all([
      readFile(token, 'utf8'),
      readFile(nginxToken, 'utf8'),
    ]);
    if (!values[0].trim() || !values[1].trim())
      blockers.push('persistent:backendTokenEmpty');
    else if (values[0] !== values[1])
      blockers.push('persistent:backendTokenMismatch');
  }
  return { actions, blockers };
}

export async function createInstallPlan(
  manifest,
  docker,
  configuration,
  now = new Date(),
) {
  const [networks, images, inventory] = await Promise.all([
    docker.listNetworks(),
    docker.listImages(),
    collectInventory(manifest, docker, now),
  ]);
  if (!Array.isArray(networks))
    throw new Error('Docker network inventory is invalid');
  if (!Array.isArray(images))
    throw new Error('Docker image inventory is invalid');
  const actions = [];
  const blockers = [];
  const persistent = await persistentStatePlan(configuration);
  actions.push(...persistent.actions);
  blockers.push(...persistent.blockers);
  const existingNetworks = new Map(
    networks.map((network) => [network.Name, network]),
  );
  const availableImages = new Set(
    images.flatMap((image) => [
      ...(image.RepoTags ?? []),
      ...(image.RepoDigests ?? []),
    ]),
  );

  for (const desired of manifest.networks ?? []) {
    const current = existingNetworks.get(desired.name);
    if (!current) {
      if (desired.external)
        blockers.push(`${desired.name}:externalNetworkMissing`);
      else actions.push({ type: 'createNetwork', network: desired.name });
      continue;
    }
    if (!desired.external) {
      const reason = networkCompatibility(current, desired, configuration);
      if (reason) blockers.push(`${desired.name}:${reason}`);
    }
  }

  for (const component of inventory.components) {
    if (component.state === 'conflict') {
      blockers.push(`${component.id}:multipleContainers`);
      continue;
    }
    if (component.state === 'missing') {
      if (!availableImages.has(configuration.images[component.id]))
        actions.push({
          type: 'pullImage',
          component: component.id,
          image: configuration.images[component.id],
        });
      actions.push({
        type: 'createContainer',
        component: component.id,
        container: manifest.components.find((item) => item.id === component.id)
          ?.canonicalName,
        image: configuration.images[component.id],
      });
      continue;
    }
    if (!component.imageRepositoryAllowed)
      blockers.push(`${component.id}:imageRepositoryNotAllowed`);
    for (const mount of component.protectedMounts) {
      if (!mount.present || !mount.writable)
        blockers.push(
          `${component.id}:${mount.target}:persistentMountMismatch`,
        );
    }
    if (component.missingNetworks.length > 0)
      blockers.push(`${component.id}:networkTopologyMismatch`);
    if (
      component.adoption === 'managed' &&
      ['created', 'stopped'].includes(component.state)
    )
      actions.push({
        type: 'startContainer',
        component: component.id,
        container: component.containerName,
        containerId: component.containerId,
      });
  }

  const stable = {
    schemaVersion: 1,
    stack: manifest.stack,
    environment: manifest.environment,
    configuration: {
      stateRoot: configuration.stateRoot,
      appdataRoot: configuration.appdataRoot,
      adminSubnet: configuration.adminSubnet,
      publicUrl: configuration.publicUrl,
      iconUrl: configuration.iconUrl,
      images: configuration.images,
      authMode: configuration.authMode,
      hostIntegration: configuration.hostIntegration,
      proxyNetwork: manifest.networks.find((network) => network.id === 'proxy')
        ?.name,
    },
    actions,
    blockers: [...new Set(blockers)].sort(),
  };
  return {
    ...stable,
    observedAt: now.toISOString(),
    fingerprint: fingerprint(stable),
    applicable: stable.blockers.length === 0,
    destructiveActions: [],
    guarantees: {
      removesContainers: false,
      removesNetworks: false,
      removesPersistentData: false,
      overwritesExistingFiles: false,
    },
  };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function createExclusive(path, content, mode = 0o600, owner) {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.writeFile(content);
    if (owner) await handle.chown(owner.uid, owner.gid);
  } finally {
    await handle.close();
  }
}

async function preparePersistentState(configuration) {
  const applicationOwner =
    configuration.applyOwnership === false
      ? undefined
      : { uid: 11002, gid: 11002 };
  for (const directory of PERSISTENT_DIRECTORIES) {
    const path = join(configuration.hostStatePath, directory);
    const wasMissing = !(await exists(path));
    await mkdir(join(configuration.hostStatePath, directory), {
      recursive: true,
      mode: directory === 'ssh' ? 0o700 : 0o750,
    });
    if (wasMissing && configuration.applyOwnership !== false) {
      const applicationOwned = [
        'home',
        'workspace',
        'logs',
        'ssh',
        'appdata',
      ].includes(directory);
      await chown(
        path,
        applicationOwned ? 11002 : 0,
        applicationOwned ? 11002 : 0,
      );
    }
  }

  const tokenPath = join(configuration.hostStatePath, 'backend-token.txt');
  const nginxTokenPath = join(
    configuration.hostStatePath,
    'backend-token-nginx.txt',
  );
  const tokenExists = await exists(tokenPath);
  const nginxTokenExists = await exists(nginxTokenPath);
  if (!tokenExists && !nginxTokenExists) {
    const token = `${randomBytes(32).toString('base64url')}\n`;
    await createExclusive(tokenPath, token, 0o600, applicationOwner);
    await createExclusive(nginxTokenPath, token);
  } else if (tokenExists && !nginxTokenExists) {
    await createExclusive(nginxTokenPath, await readFile(tokenPath));
  } else if (!tokenExists && nginxTokenExists) {
    await createExclusive(
      tokenPath,
      await readFile(nginxTokenPath),
      0o600,
      applicationOwner,
    );
  } else {
    const [applicationToken, ingressToken] = await Promise.all([
      readFile(tokenPath, 'utf8'),
      readFile(nginxTokenPath, 'utf8'),
    ]);
    if (applicationToken !== ingressToken)
      throw new Error('backendTokenMismatch');
  }

  const openAiPath = join(configuration.hostStatePath, 'openai-api-key.txt');
  if (!(await exists(openAiPath)))
    await createExclusive(openAiPath, '', 0o600, applicationOwner);

  const defaults = configuration.defaultsPath;
  for (const file of ['nginx.conf.template', 'squid.conf']) {
    const destination = join(configuration.hostStatePath, 'config', file);
    if (!(await exists(destination)))
      await createExclusive(
        destination,
        file === 'nginx.conf.template'
          ? (
              await readFile(
                join(
                  defaults,
                  configuration.authMode === 'native'
                    ? 'nginx.native.conf.template'
                    : file,
                ),
                'utf8',
              )
            ).replaceAll(
              'http://mergeron-ui:',
              `http://${configuration.stackPrefix ?? 'mergeron'}-ui:`,
            )
          : await readFile(join(defaults, file)),
        0o644,
      );
  }
}

function labels(manifest, component, configuration) {
  return {
    ...MANAGED_LABELS,
    'io.mergeron.stack': manifest.stack,
    'io.mergeron.component': component.id,
    ...hostLabels(component, configuration),
  };
}

function endpoints(component) {
  return Object.fromEntries(
    component.requiredNetworks.map((network) => [
      network,
      {
        Aliases:
          component.id === 'application'
            ? [component.canonicalName, component.stackName]
            : [component.canonicalName],
      },
    ]),
  );
}

function commonHostConfig({ binds, memory, nanoCpus, pidsLimit, tmpfs = {} }) {
  return {
    Binds: binds,
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    PidsLimit: pidsLimit,
    Memory: memory,
    NanoCpus: nanoCpus,
    Tmpfs: tmpfs,
    RestartPolicy: { Name: 'unless-stopped' },
    LogConfig: {
      Type: 'json-file',
      Config: { 'max-size': '10m', 'max-file': '3' },
    },
  };
}

export function containerSpecification(manifest, component, configuration) {
  const root = configuration.stateRoot;
  const base = {
    Image: configuration.images[component.id],
    Labels: labels(manifest, component, configuration),
    NetworkingConfig: { EndpointsConfig: endpoints(component) },
  };
  if (component.id === 'application') {
    return {
      ...base,
      User: '11002:11002',
      WorkingDir: '/app',
      Entrypoint: ['sh', '-c'],
      Cmd: [
        'export WEBUI_API_KEY="$(cat /run/secrets/backend_token)"; exec /usr/local/bin/entrypoint.sh node /app/dist/main.js',
      ],
      Env: [
        `NODE_ENV=${manifest.environment}`,
        `MERGERON_STACK_ENVIRONMENT=${manifest.environment}`,
        'PORT=8172',
        'HOME=/home/codex',
        'CODEX_HOME=/home/codex/.codex',
        'MERGERON_PUBLISHED_DOCUMENT_PROTECTION=required',
        'WEBUI_DB_PATH=/home/codex/.codex/codex-webui.sqlite',
        'WEBUI_REQUIRE_IDENTITY=true',
        `MERGERON_PUBLIC_URL=${configuration.publicUrl}`,
        'MERGERON_MANAGER_SOCKET=/run/mergeron-manager/manager.sock',
        'WEBUI_PROTECTED_PATHS=/home/codex,/run/secrets,/app,/proc,/sys,/dev,/etc,/root,/appdata/mergeron',
        'WORKSPACE_ROOTS=/workspaces,/appdata',
        'LOG_LEVEL=info',
        'OPENAI_API_KEY_FILE=/run/secrets/openai_api_key',
        'OPENAI_CHAT_MODEL=gpt-5-mini',
        `HTTP_PROXY=http://${manifest.stack}-squid:3128`,
        `HTTPS_PROXY=http://${manifest.stack}-squid:3128`,
        `ALL_PROXY=http://${manifest.stack}-squid:3128`,
        `NO_PROXY=127.0.0.1,localhost,${manifest.stack}-ui`,
        `http_proxy=http://${manifest.stack}-squid:3128`,
        `https_proxy=http://${manifest.stack}-squid:3128`,
        `all_proxy=http://${manifest.stack}-squid:3128`,
        `no_proxy=127.0.0.1,localhost,${manifest.stack}-ui`,
        'TZ=Europe/Paris',
      ],
      Healthcheck: {
        Test: [
          'CMD-SHELL',
          'token=$(cat /run/secrets/backend_token) && curl -fsS -H "Authorization: Bearer $token" http://127.0.0.1:8172/api/status >/dev/null',
        ],
        Interval: 20_000_000_000,
        Timeout: 5_000_000_000,
        Retries: 8,
        StartPeriod: 90_000_000_000,
      },
      HostConfig: {
        ...commonHostConfig({
          binds: [
            `${root}/home:/home/codex`,
            `${root}/workspace:/workspaces`,
            `${configuration.appdataRoot}:/appdata`,
            `${root}/logs:/app/logs`,
            `${root}/backend-token.txt:/run/secrets/backend_token:ro`,
            `${root}/openai-api-key.txt:/run/secrets/openai_api_key:ro`,
            `${root}/ssh:/home/codex/.ssh:ro`,
            `${root}/manager-run:/run/mergeron-manager`,
          ],
          memory: 8 * 1024 ** 3,
          nanoCpus: 3_500_000_000,
          pidsLimit: 1024,
          tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m,mode=1777' },
        }),
        Init: true,
        GroupAdd: ['11001'],
        StopTimeout: 1800,
        // Docker CLI translates systempaths=unconfined into these API fields.
        SecurityOpt: ['no-new-privileges:true', documentSeccompProfile()],
        MaskedPaths: [],
        ReadonlyPaths: [],
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '20m', 'max-file': '5' },
        },
      },
    };
  }
  if (component.id === 'ingress') {
    return {
      ...base,
      Cmd: [
        'sh',
        '-c',
        "export MERGERON_BACKEND_TOKEN=\"$(cat /run/secrets/backend_token)\"; envsubst '${MERGERON_BACKEND_TOKEN}' < /etc/nginx/templates-secure/nginx.conf.template > /tmp/nginx.conf; exec nginx -c /tmp/nginx.conf -g 'daemon off;'",
      ],
      Healthcheck: {
        Test: [
          'CMD',
          'curl',
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '3',
          'http://127.0.0.1:8080/_health',
        ],
        Interval: 20_000_000_000,
        Timeout: 5_000_000_000,
        Retries: 5,
        StartPeriod: 20_000_000_000,
      },
      HostConfig: {
        ...commonHostConfig({
          binds: [
            `${root}/config/nginx.conf.template:/etc/nginx/templates-secure/nginx.conf.template:ro`,
            `${root}/backend-token-nginx.txt:/run/secrets/backend_token:ro`,
          ],
          memory: 128 * 1024 ** 2,
          nanoCpus: 500_000_000,
          pidsLimit: 128,
          tmpfs: {
            '/var/cache/nginx': 'rw,nosuid,nodev,size=32m',
            '/var/run': 'rw,nosuid,nodev,size=4m',
            '/tmp': 'rw,nosuid,nodev,size=16m',
          },
        }),
        CapAdd: ['CHOWN', 'SETGID', 'SETUID'],
      },
    };
  }
  return {
    ...base,
    HostConfig: {
      ...commonHostConfig({
        binds: [`${root}/config/squid.conf:/etc/squid/squid.conf:ro`],
        memory: 512 * 1024 ** 2,
        nanoCpus: 500_000_000,
        pidsLimit: 256,
        tmpfs: {
          '/var/log/squid': 'rw,nosuid,nodev,size=32m,mode=1777',
          '/var/spool/squid': 'rw,nosuid,nodev,size=32m',
          '/run': 'rw,nosuid,nodev,size=4m',
          '/tmp': 'rw,nosuid,nodev,size=16m',
        },
      }),
      CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID'],
    },
    Healthcheck: {
      Test: ['CMD', '/usr/bin/pidof', 'squid'],
      Interval: 20_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 5,
      StartPeriod: 20_000_000_000,
    },
  };
}

export async function applyInstallPlan({
  manifest,
  docker,
  configuration,
  expectedFingerprint,
  confirmation,
  automatic = false,
}) {
  if (!automatic && confirmation !== INSTALL_CONFIRMATION)
    throw new Error('installationConfirmationRequired');
  const plan = await createInstallPlan(manifest, docker, configuration);
  if (plan.fingerprint !== expectedFingerprint && !automatic)
    throw new Error('installationPlanChanged');
  if (!plan.applicable) throw new Error('installationBlocked');
  if (plan.actions.length === 0) return { plan, applied: [], changed: false };

  await preparePersistentState(configuration);
  const applied = plan.actions.filter((item) =>
    ['createDirectory', 'createFile'].includes(item.type),
  );
  for (const action of plan.actions.filter(
    (item) => item.type === 'createNetwork',
  )) {
    const desired = manifest.networks.find(
      (item) => item.name === action.network,
    );
    const request = {
      Name: desired.name,
      Driver: 'bridge',
      Internal: Boolean(desired.internal),
      Labels: {
        ...MANAGED_LABELS,
        'io.mergeron.stack': manifest.stack,
        'io.mergeron.resource': 'network',
      },
      ...(desired.subnetFromConfiguration
        ? { IPAM: { Config: [{ Subnet: configuration.adminSubnet }] } }
        : {}),
    };
    await docker.createNetwork(request);
    applied.push(action);
  }

  for (const action of plan.actions.filter(
    (item) => item.type === 'pullImage',
  )) {
    await docker.pullImage(action.image);
    applied.push(action);
  }

  const order = ['egress', 'application', 'ingress'];
  for (const id of order) {
    const action = plan.actions.find(
      (item) => item.type === 'createContainer' && item.component === id,
    );
    if (!action) continue;
    const component = manifest.components.find((item) => item.id === id);
    const created = await docker.createContainer(
      component.canonicalName,
      containerSpecification(manifest, component, configuration),
    );
    await docker.startContainer(created.Id);
    applied.push(action);
  }
  for (const id of order) {
    const action = plan.actions.find(
      (item) => item.type === 'startContainer' && item.component === id,
    );
    if (!action) continue;
    await docker.startContainer(action.containerId);
    applied.push(action);
  }
  return { plan, applied, changed: applied.length > 0 };
}
