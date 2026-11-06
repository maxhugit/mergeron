import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { specification } from './updater.mjs';

export const replacementFingerprint = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function saveReplacement(path, job) {
  await writeFile(path + '.tmp', JSON.stringify(job), { mode: 0o600 });
  const file = await open(path + '.tmp', 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(path + '.tmp', path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export class ManagerReplacement {
  constructor({ docker, stack, directory, enabled = false }) {
    Object.assign(this, { docker, stack, directory, enabled });
  }
  async plan(image) {
    if (!this.enabled) throw new Error('updateIndependentMonitorRequired');
    if (
      !/^ghcr.io\/maxhugit\/mergeron-manager@sha256:[a-f0-9]{64}$/.test(image)
    )
      throw new Error('updateImageNotAllowed');
    const inspect = await this.docker.inspectContainer(`${this.stack}-manager`);
    if (
      inspect.Name !== `/${this.stack}-manager` ||
      inspect.HostConfig.NetworkMode !== 'none' ||
      !inspect.State.Running
    )
      throw new Error('updateManagerIdentityChanged');
    const state = inspect.Mounts.find(
      (m) =>
        m.Destination === '/var/lib/mergeron-manager' &&
        m.Type === 'bind' &&
        m.RW,
    );
    const socket = inspect.Mounts.find(
      (m) => m.Destination === '/var/run/docker.sock' && m.Type === 'bind',
    );
    const run = inspect.Mounts.find(
      (m) => m.Destination === '/run/mergeron-manager' && m.Type === 'bind',
    );
    if (!state || !socket || !run)
      throw new Error('updateManagerMountsInvalid');
    const source = await this.docker.inspectImage(inspect.Image);
    if (
      source.Id !== inspect.Image ||
      source.Config?.Labels?.['io.mergeron.continuous-updates'] !== '1'
    )
      throw new Error('updateManagerUpgradeRequired');
    const original = specification(inspect, inspect.Image);
    delete original.NetworkingConfig; // NetworkMode none is authoritative; never attach an endpoint.
    const identity = {
      id: inspect.Id,
      image: inspect.Image,
      specification: original,
    };
    return {
      image,
      fingerprint: replacementFingerprint({ image, ...identity }),
      originalId: inspect.Id,
      original,
      sourceImage: inspect.Image,
      stateSource: state.Source,
      dockerSource: socket.Source,
      runSource: run.Source,
    };
  }
  async launch(plan, operationId) {
    const current = await this.plan(plan.image);
    if (current.fingerprint !== plan.fingerprint)
      throw new Error('updateManagerIdentityChanged');
    await this.docker.pullImage(plan.image);
    const target = await this.docker.inspectImage(plan.image);
    if (!/^sha256:[a-f0-9]{64}$/.test(target.Id ?? ''))
      throw new Error('updateManagerImageInvalid');
    const id = randomUUID();
    const job = {
      id,
      operationId,
      stack: this.stack,
      image: plan.image,
      targetImageId: target.Id,
      originalId: plan.originalId,
      original: plan.original,
      stage: 'waiting',
      createdAt: new Date().toISOString(),
    };
    const directory = join(this.directory, 'replacements');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await saveReplacement(join(directory, id + '.json'), job);
    const helper = await this.docker.createContainer(
      `${this.stack}-manager-replacement-${id}`,
      {
        Image: plan.sourceImage,
        User: '0:0',
        Entrypoint: ['/nodejs/bin/node', 'src/manager-replacement-worker.mjs'],
        Cmd: [id],
        Env: [],
        Labels: {
          'io.mergeron.stack': this.stack,
          'io.mergeron.component': 'managerReplacement',
          'io.mergeron.replacement': id,
        },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          PidsLimit: 64,
          Memory: 128 * 1024 * 1024,
          RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
          Binds: [
            `${plan.dockerSource}:/var/run/docker.sock:ro`,
            `${plan.stateSource}:/state`,
            `${plan.runSource}:/manager-run:ro`,
          ],
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=4m' },
        },
        Healthcheck: { Test: ['NONE'] },
      },
    );
    await this.docker.startContainer(helper.Id);
    return { id, helperId: helper.Id };
  }
  async cancel(handle) {
    await this.docker.stopContainer(handle.helperId);
    await this.docker.removeContainer(handle.helperId);
  }
  async busy() {
    try {
      const state = JSON.parse(
        await readFile(
          join(this.directory, 'maintenance', 'state.json'),
          'utf8',
        ),
      );
      return (
        state.operation?.status === 'running' &&
        ['managerPending', 'managerReplacing', 'managerChecking'].includes(
          state.operation.phase,
        )
      );
    } catch {
      return false;
    }
  }
}
