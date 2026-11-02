import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { installedImageBuild } from './installed-build.mjs';

export const TRANSCRIPTION_REPOSITORY =
  'ghcr.io/maxhugit/mergeron-transcription';
const ownerPattern = /^[a-f0-9-]{36}$/i;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

/** Optional CPU worker. Only its reviewed image/name/network can be operated. */
export class ManagedTranscription {
  task = null;
  phase = 'stopped';
  error = null;
  leases = new Map();
  updateInfo = {};
  checkingUpdates = null;
  constructor({
    docker,
    manifest,
    configuration,
    inventory,
    blocked = () => false,
    now = Date.now,
    env = process.env,
  }) {
    Object.assign(this, {
      docker,
      manifest,
      configuration,
      inventory,
      blocked,
      now,
    });
    this.enabled = env.MERGERON_TRANSCRIPTION_ENABLED === 'true';
    this.diarization = env.MERGERON_TRANSCRIPTION_DIARIZATION === 'true';
    this.name = manifest.stack + '-transcription';
    this.image =
      env.MERGERON_TRANSCRIPTION_IMAGE?.trim() ||
      TRANSCRIPTION_REPOSITORY +
        (manifest.environment !== 'production' ? ':edge' : ':latest');
    if (
      !this.image.startsWith(TRANSCRIPTION_REPOSITORY) ||
      !/^(?::[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})$/.test(
        this.image.slice(TRANSCRIPTION_REPOSITORY.length),
      )
    )
      throw Error('TRANSCRIPTION_IMAGE_NOT_ALLOWED');
    this.idleMs = Number(env.MERGERON_TRANSCRIPTION_IDLE_SECONDS ?? 300) * 1000;
    if (
      !Number.isInteger(this.idleMs) ||
      this.idleMs < 30_000 ||
      this.idleMs > 86400_000
    )
      throw Error('TRANSCRIPTION_INVALID_POLICY');
    this.idleSince = now();
  }
  get busy() {
    return !!this.task || this.leases.size > 0;
  }
  labels() {
    return {
      'io.mergeron.managed': 'true',
      'io.mergeron.component': 'transcription',
      'io.mergeron.stack': this.manifest.stack,
    };
  }
  async current() {
    let item;
    try {
      item = await this.docker.inspectContainer(this.name);
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
    const labels = item.Config?.Labels ?? {};
    const network = this.manifest.networks.find(
      (n) => n.id === 'isolated',
    )?.name;
    const host = item.HostConfig ?? {};
    if (
      item.Name !== '/' + this.name ||
      Object.entries(this.labels()).some(
        ([key, value]) => labels[key] !== value,
      ) ||
      (!String(item.Config.Image).startsWith(TRANSCRIPTION_REPOSITORY + ':') &&
        !String(item.Config.Image).startsWith(
          TRANSCRIPTION_REPOSITORY + '@sha256:',
        )) ||
      host.Privileged ||
      host.Memory !== 6 * 1024 ** 3 ||
      host.NanoCpus !== 2e9 ||
      host.PidsLimit !== 128 ||
      host.PidMode ||
      host.IpcMode === 'host' ||
      host.Devices?.length ||
      host.DeviceRequests?.length ||
      host.VolumesFrom?.length ||
      host.RestartPolicy?.Name !== 'no' ||
      !host.ReadonlyRootfs ||
      host.NetworkMode !== network ||
      item.Config.User !== '11003:11003' ||
      !host.CapDrop?.includes('ALL') ||
      host.CapAdd?.length ||
      Object.keys(host.PortBindings ?? {}).length ||
      !host.SecurityOpt?.includes('no-new-privileges:true') ||
      JSON.stringify(Object.keys(item.NetworkSettings?.Networks ?? {})) !==
        JSON.stringify([network]) ||
      (item.Mounts ?? []).some(
        (m) =>
          !(m.Type === 'tmpfs' && m.Destination === '/tmp') &&
          (m.Destination !== '/models/diarization' ||
            m.Source !==
              join(
                this.configuration.stateRoot,
                'config/transcription-diarization',
              ) ||
            m.Type !== 'bind' ||
            m.RW),
      )
    )
      throw Error('TRANSCRIPTION_OWNERSHIP');
    return item;
  }
  prune() {
    const count = this.leases.size;
    for (const [key, expires] of this.leases)
      if (expires <= this.now()) this.leases.delete(key);
    if (count && !this.leases.size) this.idleSince = this.now();
  }
  async status() {
    this.prune();
    const value = {
      enabled: this.enabled,
      state: this.task ? this.phase : 'stopped',
      activeLeases: this.leases.size,
      idleSeconds: this.idleMs / 1000,
      error: this.error,
      image: this.image,
      build: null,
      containerId: null,
      installedImageId: null,
      updateAvailable: false,
      updateCheckError: null,
      ...this.updateInfo,
    };
    try {
      const item = await this.current();
      if (!item)
        return {
          ...value,
          state: !this.enabled
            ? 'disabled'
            : this.task
              ? this.phase
              : this.error
                ? 'error'
                : 'missing',
        };
      const local = await this.docker.inspectImage(item.Image);
      return {
        ...value,
        containerId: item.Id,
        installedImageId: local.Id,
        platform: {
          os: local.Os,
          architecture: local.Architecture,
          variant: local.Variant,
        },
        build: installedImageBuild(local, 'transcription'),
        state: this.task
          ? this.phase
          : this.error
            ? 'error'
            : !item.State.Running
              ? 'stopped'
              : item.State.Health?.Status === 'healthy'
                ? 'ready'
                : item.State.Health?.Status === 'unhealthy'
                  ? 'error'
                  : 'starting',
      };
    } catch (error) {
      return {
        ...value,
        state: 'error',
        error:
          error.message === 'TRANSCRIPTION_OWNERSHIP'
            ? 'TRANSCRIPTION_OWNERSHIP'
            : 'TRANSCRIPTION_STATUS_UNAVAILABLE',
      };
    }
  }
  async ensure() {
    if (this.blocked()) throw Error('TRANSCRIPTION_BUSY');
    this.phase = 'downloading';
    try {
      await this.docker.inspectImage(this.image);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      await this.docker.pullImage(this.image);
    }
    const inventory = await this.inventory();
    const app = inventory.components.find((c) => c.id === 'application');
    if (!app?.containerId || app.adoption !== 'managed')
      throw Error('TRANSCRIPTION_STACK_NOT_MANAGED');
    const network = this.manifest.networks.find((n) => n.id === 'isolated');
    const existingNetwork = await this.docker.inspectNetwork(network.name);
    if (
      !network.internal ||
      !existingNetwork.Internal ||
      existingNetwork.Driver !== 'bridge'
    )
      throw Error('TRANSCRIPTION_NETWORK');
    let item = await this.current();
    if (!item) {
      const binds = [];
      if (this.diarization) {
        for (const name of ['config', 'config/transcription-diarization']) {
          const value = await lstat(
            join(this.configuration.hostStatePath, name),
          );
          if (value.isSymbolicLink() || !value.isDirectory())
            throw Error('TRANSCRIPTION_DIARIZATION_PATH');
        }
        binds.push(
          join(
            this.configuration.stateRoot,
            'config/transcription-diarization',
          ) + ':/models/diarization:ro',
        );
      }
      if (this.blocked()) throw Error('TRANSCRIPTION_BUSY');
      this.phase = 'creating';
      const created = await this.docker.createContainer(this.name, {
        Image: this.image,
        User: '11003:11003',
        Labels: this.labels(),
        Env: ['TRANSCRIPTION_TOKEN=' + randomBytes(32).toString('hex')],
        NetworkingConfig: {
          EndpointsConfig: { [network.name]: { Aliases: [this.name] } },
        },
        HostConfig: {
          NetworkMode: network.name,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Memory: 6 * 1024 ** 3,
          NanoCpus: 2e9,
          PidsLimit: 128,
          Init: true,
          Binds: binds,
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=1g,mode=1777' },
          RestartPolicy: { Name: 'no' },
          LogConfig: {
            Type: 'json-file',
            Config: { 'max-size': '2m', 'max-file': '2' },
          },
          Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
        },
      });
      item = await this.docker.inspectContainer(created.Id);
    }
    if (this.blocked()) throw Error('TRANSCRIPTION_BUSY');
    this.phase = 'starting';
    if (!item.State.Running) await this.docker.startContainer(item.Id);
    this.error = null;
  }
  async lease(input = {}) {
    if (
      !input ||
      typeof input.owner !== 'string' ||
      !ownerPattern.test(input.owner) ||
      Object.keys(input).some((k) => !['owner', 'release'].includes(k)) ||
      (input.release !== undefined && typeof input.release !== 'boolean')
    )
      throw Error('TRANSCRIPTION_INVALID_REQUEST');
    this.prune();
    if (input.release) {
      const removed = this.leases.delete(input.owner);
      if (removed && !this.leases.size) this.idleSince = this.now();
      return this.status();
    }
    if (!this.enabled) throw Error('TRANSCRIPTION_DISABLED');
    if (this.blocked()) throw Error('TRANSCRIPTION_BUSY');
    if (!this.leases.has(input.owner) && this.leases.size >= 16)
      throw Error('TRANSCRIPTION_BUSY');
    // A new user job may retry a previous startup failure; renewals never loop it.
    if (!this.leases.has(input.owner)) this.error = null;
    this.leases.set(input.owner, this.now() + 90_000);
    const status = await this.status();
    if (!this.task && ['missing', 'stopped'].includes(status.state)) {
      this.task = this.ensure()
        .catch((error) => {
          this.error = /^TRANSCRIPTION_[A-Z_]+$/.test(error.message ?? '')
            ? error.message
            : 'TRANSCRIPTION_START_FAILED';
          this.phase = 'error';
        })
        .finally(() => {
          this.task = null;
        });
    }
    const latest = await this.status();
    if (latest.state === 'ready') {
      const current = await this.current();
      const token = current.Config.Env?.find((e) =>
        e.startsWith('TRANSCRIPTION_TOKEN='),
      )?.slice(20);
      if (!/^[a-f0-9]{64}$/.test(token ?? ''))
        throw Error('TRANSCRIPTION_OWNERSHIP');
      // This private transport is returned only over the Manager socket, never by the public API.
      return {
        ...latest,
        transport: { url: 'http://' + this.name + ':8090', token },
      };
    }
    return latest;
  }
  async tick() {
    this.prune();
    if (
      this.task ||
      this.blocked() ||
      this.leases.size ||
      this.now() - this.idleSince < this.idleMs
    )
      return;
    this.phase = 'stopping';
    this.task = (async () => {
      const item = await this.current();
      this.prune();
      if (!this.leases.size && !this.blocked() && item?.State.Running)
        await this.docker.stopContainer(item.Id, 15);
    })();
    try {
      await this.task;
    } finally {
      this.task = null;
    }
  }
  async updates() {
    const status = await this.status();
    if (!status.containerId) return status;
    try {
      const distribution = await this.docker.inspectDistribution(this.image);
      const digest = distribution?.Descriptor?.digest;
      if (!digestPattern.test(digest ?? '')) throw Error('invalid');
      const image = await this.docker.inspectImage(status.installedImageId);
      this.updateInfo = {
        registryDigest: digest,
        platformCheckRequired: !(image.RepoDigests ?? []).some(
          (ref) => ref === TRANSCRIPTION_REPOSITORY + '@' + digest,
        ),
        updateCheckError: null,
      };
      return {
        ...status,
        registryDigest: digest,
        updateAvailable: false,
        platformCheckRequired: !(image.RepoDigests ?? []).some(
          (ref) => ref === TRANSCRIPTION_REPOSITORY + '@' + digest,
        ),
      };
    } catch {
      this.updateInfo = {
        updateCheckError: 'TRANSCRIPTION_REGISTRY_UNAVAILABLE',
      };
      return {
        ...status,
        updateCheckError: 'TRANSCRIPTION_REGISTRY_UNAVAILABLE',
      };
    }
  }
}
