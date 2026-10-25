import http from 'node:http';
import net from 'node:net';
import { chmod, chown, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerClient } from './docker-client.mjs';
import { TransactionalUpdater } from './updater.mjs';
import {
  confirmAdoption,
  evaluateAdoption,
  readAdoptionRecord,
} from './adoption.mjs';
import {
  collectInventory,
  scopeManifest,
  unavailableInventory,
} from './inventory.mjs';
import {
  applyInstallPlan,
  createInstallPlan,
  readInstallConfiguration,
} from './installer.mjs';

const manifestPath = fileURLToPath(
  new URL('../stack-manifest.json', import.meta.url),
);
const manifest = scopeManifest(
  JSON.parse(await readFile(manifestPath, 'utf8')),
  process.env.MERGERON_STACK_PREFIX,
  process.env.MERGERON_STACK_ENVIRONMENT,
  process.env.MERGERON_PROXY_NETWORK,
);
const socketPath =
  process.env.MERGERON_MANAGER_SOCKET ?? '/run/mergeron-manager/manager.sock';
const socketGroup = Number(process.env.MERGERON_MANAGER_SOCKET_GID ?? 11002);
const adoptionPath =
  process.env.MERGERON_MANAGER_ADOPTION_PATH ??
  '/var/lib/mergeron-manager/adoption.json';
const pollInterval = Math.max(
  5_000,
  Number(process.env.MERGERON_MANAGER_POLL_MS ?? 20_000),
);
const docker = new DockerClient(
  process.env.MERGERON_DOCKER_SOCKET ?? '/var/run/docker.sock',
);
const installConfiguration = readInstallConfiguration(manifest);
const updater = new TransactionalUpdater({
  manifest,
  docker,
  configuration: installConfiguration,
  adoptionPath,
  directory: `${dirname(adoptionPath)}/updates`,
});
let ready = false;

let snapshot = unavailableInventory(
  manifest,
  new Error('Inventory not collected yet'),
);
let refreshing = null;
let adopting = null;
let installing = null;
const events = [];

function signature(value) {
  return JSON.stringify(
    value.components.map((component) => ({
      id: component.id,
      state: component.state,
      adoption: component.adoption,
      networks: component.networks,
      mounts: component.protectedMounts.map((mount) => ({
        target: mount.target,
        present: mount.present,
        writable: mount.writable,
      })),
    })),
  );
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const previous = snapshot;
    try {
      const inventory = await collectInventory(manifest, {
        listContainers: async () =>
          (await docker.listContainers()).filter(
            (container) =>
              !updater.current?.containers?.some(
                (item) =>
                  item.id === container.Id &&
                  container.Names?.includes(`/${item.backupName}`),
              ),
          ),
        inspectContainer: (id) => docker.inspectContainer(id),
      });
      snapshot = evaluateAdoption(
        inventory,
        await readAdoptionRecord(adoptionPath),
      );
    } catch (error) {
      snapshot = unavailableInventory(manifest, error);
    }
    if (signature(previous) !== signature(snapshot)) {
      events.push({ at: snapshot.observedAt, type: 'inventoryChanged' });
      if (events.length > 100) events.splice(0, events.length - 100);
    }
    return snapshot;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024)
        request.destroy(new Error('requestBodyTooLarge'));
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalidJsonBody'));
      }
    });
    request.on('error', reject);
  });
}

async function adopt(body) {
  if (
    !ready ||
    installing ||
    updater.busy ||
    updater.current?.status === 'recoveryRequired'
  )
    throw new Error('managerOperationInProgress');
  if (adopting) return adopting;
  adopting = (async () => {
    const inventory = await collectInventory(manifest, docker);
    const result = await confirmAdoption({
      inventory,
      existingRecord: await readAdoptionRecord(adoptionPath),
      confirmation: body?.confirmation,
      expectedFingerprint: body?.expectedFingerprint,
      path: adoptionPath,
    });
    snapshot = result;
    events.push({ at: result.observedAt, type: 'installationAdopted' });
    if (events.length > 100) events.splice(0, events.length - 100);
    return result;
  })();
  try {
    return await adopting;
  } finally {
    adopting = null;
  }
}

async function installationPlan() {
  return createInstallPlan(manifest, docker, installConfiguration);
}

async function install(body, automatic = false) {
  if (
    !ready ||
    adopting ||
    updater.busy ||
    updater.current?.status === 'recoveryRequired'
  )
    throw new Error('managerOperationInProgress');
  if (installing) return installing;
  installing = (async () => {
    const result = await applyInstallPlan({
      manifest,
      docker,
      configuration: installConfiguration,
      expectedFingerprint: body?.expectedFingerprint,
      confirmation: body?.confirmation,
      automatic,
    });
    events.push({
      at: new Date().toISOString(),
      type: result.changed
        ? 'installationApplied'
        : 'installationAlreadyCurrent',
      actions: result.applied,
    });
    if (events.length > 100) events.splice(0, events.length - 100);
    await refresh();
    return result;
  })();
  try {
    return await installing;
  } finally {
    installing = null;
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  if (request.url === '/healthz') {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'methodNotAllowed' });
      return;
    }
    json(response, 200, { status: 'ok', mode: 'install' });
    return;
  }
  if (request.url === '/v1/status') {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'methodNotAllowed' });
      return;
    }
    await refresh();
    json(response, 200, {
      ...snapshot,
      events: [...events],
      update: updater.status(),
      capabilities: { backupManagement: true },
    });
    return;
  }
  if (
    [
      '/v1/update/plan',
      '/v1/update',
      '/v1/update/rollback',
      '/v1/update/recover',
    ].includes(request.url) &&
    request.method === 'POST'
  ) {
    try {
      if (!ready || installing || adopting || updater.busy)
        throw new Error('managerOperationInProgress');
      const body = await readJsonBody(request);
      if (request.url === '/v1/update/plan')
        json(response, 200, await updater.plan(body.images));
      else if (request.url === '/v1/update/rollback')
        json(response, 200, await updater.requestRollback(body));
      else if (request.url === '/v1/update/recover') {
        if (body.confirmation !== 'RETRY_RECOVERY')
          throw new Error('updateConfirmationRequired');
        void updater
          .recover()
          .catch((error) => console.error(updater.safeError(error)));
        json(response, 200, updater.status());
      } else json(response, 200, await updater.begin(body));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'updateFailed';
      json(
        response,
        code === 'updateConfirmationRequired' || code === 'invalidJsonBody'
          ? 400
          : 409,
        { error: code },
      );
    }
    return;
  }
  if (request.url === '/v1/backups' && request.method === 'GET') {
    try {
      json(response, 200, await updater.listBackups());
    } catch {
      json(response, 503, { error: 'managerBackupsUnavailable' });
    }
    return;
  }
  if (request.url === '/v1/backups/delete' && request.method === 'POST') {
    try {
      if (!ready || installing || adopting || updater.busy)
        throw new Error('managerOperationInProgress');
      json(
        response,
        200,
        await updater.deleteBackup(await readJsonBody(request)),
      );
    } catch (error) {
      const code =
        error instanceof Error && /^manager[A-Za-z]+$/.test(error.message)
          ? error.message
          : 'managerBackupDeleteFailed';
      json(response, code === 'managerBackupConfirmationRequired' ? 400 : 409, {
        error: code,
      });
    }
    return;
  }
  if (request.url === '/v1/adoption' && request.method === 'POST') {
    try {
      const result = await adopt(await readJsonBody(request));
      json(response, 200, { ...result, events: [...events] });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'adoptionFailed';
      const status =
        code === 'adoptionConfirmationRequired' || code === 'invalidJsonBody'
          ? 400
          : 409;
      json(response, status, { error: code });
    }
    return;
  }
  if (request.url === '/v1/install/plan' && request.method === 'GET') {
    try {
      json(response, 200, await installationPlan());
    } catch (error) {
      json(response, 503, {
        error:
          error instanceof Error ? error.message : 'installationPlanFailed',
      });
    }
    return;
  }
  if (request.url === '/v1/install' && request.method === 'POST') {
    try {
      json(response, 200, await install(await readJsonBody(request)));
    } catch (error) {
      const code =
        error instanceof Error ? error.message : 'installationFailed';
      const status =
        code === 'installationConfirmationRequired' ||
        code === 'invalidJsonBody'
          ? 400
          : 409;
      json(response, status, { error: code });
    }
    return;
  }
  if (request.method !== 'GET') {
    json(response, 405, { error: 'methodNotAllowed' });
    return;
  }
  json(response, 404, { error: 'notFound' });
});

await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
// Do not unlink a live Manager's socket: this also serializes all stack writers.
await new Promise((resolve, reject) => {
  const probe = net.createConnection(socketPath);
  probe.once('connect', () => {
    probe.destroy();
    reject(new Error('managerAlreadyRunning'));
  });
  probe.once('error', (error) =>
    ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? resolve() : reject(error),
  );
});
await rm(socketPath, { force: true });
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  if (Number.isInteger(socketGroup) && socketGroup >= 0) {
    await chown(socketPath, 0, socketGroup).catch(() => undefined);
  }
  await updater.recover();
  ready = true;
  await refresh();
  if (installConfiguration.enabled) {
    try {
      await install({}, true);
    } catch (error) {
      events.push({
        at: new Date().toISOString(),
        type: 'installationBlocked',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  setInterval(() => void refresh(), pollInterval).unref();
  console.log(`Mergeron Manager socket ready at ${socketPath}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
