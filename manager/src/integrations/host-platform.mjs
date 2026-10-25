// Optional host UI metadata and historical environment aliases. Neither is
// required for installing or updating Mergeron on a generic Docker host.
export function readHostIntegration(env) {
  const value = env.MERGERON_HOST_INTEGRATION ?? 'none';
  if (!['none', 'unraid'].includes(value))
    throw new Error('MERGERON_HOST_INTEGRATION is invalid');
  return value;
}

export function readAppdataRoot(env, stateRoot) {
  return (
    env.MERGERON_APPDATA_ROOT ??
    env.MERGERON_UNRAID_APPDATA_ROOT ??
    `${stateRoot}/appdata`
  );
}

export function hostLabels(component, configuration) {
  if (configuration.hostIntegration !== 'unraid') return {};
  return {
    'net.unraid.docker.icon': configuration.iconUrl,
    'net.unraid.docker.shell':
      component.id === 'ingress' ? '/bin/sh' : '/bin/bash',
    ...(component.id === 'application'
      ? { 'net.unraid.docker.webui': configuration.publicUrl }
      : {}),
  };
}
