const MANAGED_LABEL = 'io.mergeron.managed';
const COMPONENT_LABEL = 'io.mergeron.component';
const STACK_LABEL = 'io.mergeron.stack';

export function scopeManifest(
  manifest,
  stackPrefix = manifest.stack,
  stackEnvironment = 'production',
  proxyNetwork = 'mergeron-proxy',
) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(stackPrefix)) {
    throw new Error('MERGERON_STACK_PREFIX is invalid');
  }
  if (!['production', 'development'].includes(stackEnvironment)) {
    throw new Error('MERGERON_STACK_ENVIRONMENT is invalid');
  }
  if (
    typeof proxyNetwork !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(proxyNetwork) ||
    [
      'bridge',
      'host',
      'none',
      ...['isolated', 'admin', 'external'].map((id) => `${stackPrefix}-${id}`),
    ].includes(proxyNetwork)
  ) {
    throw new Error('MERGERON_PROXY_NETWORK is invalid');
  }
  const sourceProxy = manifest.networks.find(
    (network) => network.id === 'proxy',
  )?.name;
  const scopedNetwork = (name) =>
    name === sourceProxy
      ? proxyNetwork
      : name.startsWith(`${manifest.stack}-`)
        ? `${stackPrefix}-${name.slice(manifest.stack.length + 1)}`
        : name;
  if (stackEnvironment === 'development' && stackPrefix === manifest.stack) {
    throw new Error(
      'A development stack must use a dedicated MERGERON_STACK_PREFIX',
    );
  }
  const acceptsLegacyNames =
    stackEnvironment === 'production' && stackPrefix === manifest.stack;
  const componentNames = {
    application: `${stackPrefix}-ui`,
    ingress: `${stackPrefix}-ingress`,
    egress: `${stackPrefix}-squid`,
  };
  return {
    ...manifest,
    stack: stackPrefix,
    environment: stackEnvironment,
    networks: (manifest.networks ?? []).map((network) => ({
      ...network,
      name: scopedNetwork(network.name),
    })),
    components: manifest.components.map((component) => ({
      ...component,
      stackName: stackPrefix,
      canonicalName:
        stackPrefix === manifest.stack
          ? component.canonicalName
          : componentNames[component.id],
      legacyNames: acceptsLegacyNames ? component.legacyNames : [],
      requiredNetworks: component.requiredNetworks.map(scopedNetwork),
    })),
  };
}

function normalizedNames(container) {
  return Array.isArray(container.Names)
    ? container.Names.map((name) => String(name).replace(/^\//, ''))
    : [];
}

function candidatesFor(component, containers) {
  const acceptedNames = new Set([
    component.canonicalName,
    ...(component.legacyNames ?? []),
  ]);
  return containers.filter((container) => {
    const labels = container.Labels ?? {};
    const labeledComponent =
      labels[COMPONENT_LABEL] === component.id &&
      (labels[STACK_LABEL] === component.stackName ||
        (component.stackName === 'mergeron' && !labels[STACK_LABEL]));
    return (
      labeledComponent ||
      normalizedNames(container).some((name) => acceptedNames.has(name))
    );
  });
}

function imageRepository(reference) {
  const withoutDigest = String(reference ?? '').split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash
    ? withoutDigest.slice(0, lastColon)
    : withoutDigest;
}

function componentState(inspect) {
  const running = inspect.State?.Running === true;
  const status = inspect.State?.Status;
  const health = inspect.State?.Health?.Status;
  if (!running) return status === 'created' ? 'created' : 'stopped';
  if (health === 'healthy') return 'healthy';
  if (health === 'unhealthy') return 'unhealthy';
  if (health === 'starting') return 'starting';
  return 'running';
}

function inspectMounts(component, inspect) {
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];
  return (component.protectedMounts ?? []).map((requirement) => {
    const mount = mounts.find(
      (candidate) => candidate.Destination === requirement.target,
    );
    return {
      target: requirement.target,
      purpose: requirement.purpose,
      present: Boolean(mount?.Source),
      source: mount?.Source ?? null,
      type: mount?.Type ?? null,
      writable: mount?.RW === true,
    };
  });
}

async function inspectComponent(component, containers, docker) {
  const candidates = candidatesFor(component, containers);
  if (candidates.length === 0) {
    return {
      id: component.id,
      displayName: component.displayName,
      state: 'missing',
      adoption: 'missing',
      containerId: null,
      containerName: null,
      image: null,
      imageRepositoryAllowed: null,
      health: null,
      restartCount: 0,
      networks: [],
      missingNetworks: [...component.requiredNetworks],
      protectedMounts: (component.protectedMounts ?? []).map((mount) => ({
        ...mount,
        present: false,
        source: null,
        type: null,
        writable: false,
      })),
    };
  }
  if (candidates.length > 1) {
    return {
      id: component.id,
      displayName: component.displayName,
      state: 'conflict',
      adoption: 'conflict',
      candidateNames: candidates.flatMap(normalizedNames),
      containerId: null,
      containerName: null,
      image: null,
      imageRepositoryAllowed: null,
      health: null,
      restartCount: 0,
      networks: [],
      missingNetworks: [...component.requiredNetworks],
      protectedMounts: [],
    };
  }

  const summary = candidates[0];
  const inspect = await docker.inspectContainer(summary.Id);
  const labels = inspect.Config?.Labels ?? summary.Labels ?? {};
  const networks = Object.keys(inspect.NetworkSettings?.Networks ?? {}).sort();
  const image = inspect.Config?.Image ?? summary.Image ?? null;
  const repository = imageRepository(image);
  return {
    id: component.id,
    displayName: component.displayName,
    state: componentState(inspect),
    adoption:
      labels[MANAGED_LABEL] === 'true' &&
      labels[COMPONENT_LABEL] === component.id &&
      (labels[STACK_LABEL] === component.stackName ||
        (component.stackName === 'mergeron' && !labels[STACK_LABEL]))
        ? 'managed'
        : 'adoptable',
    containerId: String(summary.Id),
    containerName:
      String(inspect.Name ?? '').replace(/^\//, '') ||
      normalizedNames(summary)[0] ||
      null,
    image,
    imageId: inspect.Image ?? null,
    imageRepositoryAllowed:
      component.allowedImageRepositories.includes(repository),
    health: inspect.State?.Health?.Status ?? null,
    restartCount: Number(inspect.RestartCount ?? 0),
    networks,
    missingNetworks: component.requiredNetworks.filter(
      (network) => !networks.includes(network),
    ),
    protectedMounts: inspectMounts(component, inspect),
  };
}

export async function collectInventory(manifest, docker, now = new Date()) {
  const containers = await docker.listContainers();
  if (!Array.isArray(containers))
    throw new Error('Docker container inventory is invalid');
  const components = await Promise.all(
    manifest.components.map((component) =>
      inspectComponent(component, containers, docker),
    ),
  );
  const protectedMounts = components.flatMap((component) =>
    component.protectedMounts.map((mount) => ({
      component: component.id,
      ...mount,
    })),
  );
  const blockers = [
    ...components
      .filter((component) => component.state === 'conflict')
      .map((component) => `${component.id}:multipleContainers`),
    ...protectedMounts
      .filter((mount) => !mount.present || !mount.writable)
      .map((mount) => `${mount.component}:${mount.target}:unprotected`),
  ];
  return {
    schemaVersion: manifest.schemaVersion,
    stack: manifest.stack,
    environment: manifest.environment,
    mode: 'observe',
    observedAt: now.toISOString(),
    dockerConnected: true,
    components,
    dataSafety: {
      status: blockers.length === 0 ? 'protected' : 'blocked',
      blockers,
      protectedMounts,
    },
  };
}

export function unavailableInventory(manifest, error, now = new Date()) {
  return {
    schemaVersion: manifest.schemaVersion,
    stack: manifest.stack,
    environment: manifest.environment,
    mode: 'observe',
    observedAt: now.toISOString(),
    dockerConnected: false,
    components: [],
    dataSafety: { status: 'unknown', blockers: [], protectedMounts: [] },
    error: error instanceof Error ? error.message : String(error),
  };
}
