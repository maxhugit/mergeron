import http from 'node:http';

export function probeManager({
  socketPath,
  deadlineMs = 2_000,
  client = http,
}) {
  return new Promise((resolve) => {
    let request;
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      request?.destroy();
      resolve({ healthy: reason === null, reason });
    };
    // A socket inactivity timeout does not bound connection establishment or
    // a response trickling bytes forever. Bound the entire HTTP operation.
    const deadline = setTimeout(
      () => finish('managerHealthTimeout'),
      deadlineMs,
    );
    try {
      request = client.request(
        { method: 'GET', path: '/healthz', socketPath, agent: false },
        (response) => {
          response.on('error', () => finish('managerHealthResponseError'));
          response.on('aborted', () => finish('managerHealthResponseError'));
          let bytes = 0;
          response.on('data', (data) => {
            bytes += data.length;
            if (bytes > 1024) finish('managerHealthResponseInvalid');
          });
          response.on('end', () => finish(null));
          if (response.statusCode !== 200) finish('managerHealthStatusInvalid');
          response.resume();
        },
      );
      request.on('error', () => finish('managerHealthUnavailable'));
      request.end();
    } catch {
      finish('managerHealthUnavailable');
    }
  });
}

/** Same recordless managed-installation contract as evaluateAdoption; never forgive drift. */
function managedInstallationReady(status) {
  const adoption = status.adoption;
  if (adoption?.state === 'adopted') return !adoption.blockers?.length;
  if (
    adoption?.state !== 'eligible' ||
    adoption.canAdopt !== false ||
    !Array.isArray(adoption.blockers) ||
    adoption.blockers.length
  )
    return false;
  const components = status.components?.filter(
    (component) => !component.observational,
  );
  return (
    Array.isArray(components) &&
    [3, 4].includes(components.length) &&
    new Set(components.map((component) => component.id)).size ===
      components.length &&
    ['application', 'ingress', 'egress'].every((id) =>
      components.some((component) => component.id === id),
    ) &&
    components.every(
      (component) =>
        ['application', 'ingress', 'egress', 'browser'].includes(
          component.id,
        ) &&
        component.containerId &&
        component.adoption === 'managed' &&
        component.imageRepositoryAllowed === true &&
        Array.isArray(component.missingNetworks) &&
        component.missingNetworks.length === 0,
    )
  );
}

/** Replacement readiness includes Docker/adoption, not just a live Node process. */
export function probeManagerReadiness({
  socketPath,
  stack,
  deadlineMs = 5000,
  client = http,
}) {
  return new Promise((resolve) => {
    let request,
      finished = false;
    const finish = (healthy) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      request?.destroy();
      resolve({ healthy });
    };
    const deadline = setTimeout(() => finish(false), deadlineMs);
    try {
      request = client.request(
        { method: 'GET', path: '/v1/status', socketPath },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            return finish(false);
          }
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
            if (Buffer.byteLength(body) > 1024 * 1024) finish(false);
          });
          response.on('error', () => finish(false));
          response.on('end', () => {
            try {
              const status = JSON.parse(body);
              finish(
                status.stack === stack &&
                  status.dockerConnected === true &&
                  managedInstallationReady(status) &&
                  status.dataSafety?.status === 'protected' &&
                  status.capabilities?.independentMonitor === true &&
                  status.capabilities?.managerReplacement === true,
              );
            } catch {
              finish(false);
            }
          });
        },
      );
      request.on('error', () => finish(false));
      request.end();
    } catch {
      finish(false);
    }
  });
}
