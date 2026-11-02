import { createHash } from 'node:crypto';

const leasePattern = /^[a-f0-9-]{36}$/i;
const seconds = (value, fallback, min, max) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error('BROWSER_RUNTIME_INVALID_POLICY');
  return n * 1000;
};

/** Fixed, reviewed companion only. No image pulls, arbitrary names or network access. */
export class BrowserLifecycle {
  leases = new Map();
  task = null;
  mutating = false;
  error = null;
  startedAt = null;
  constructor({
    docker,
    manifest,
    blocked = () => false,
    now = Date.now,
    env = process.env,
  }) {
    Object.assign(this, { docker, manifest, blocked, now });
    this.component = manifest.components.find((c) => c.id === 'browser');
    this.idleMs = seconds(env.MERGERON_BROWSER_IDLE_SECONDS, 300, 30, 86400);
    this.startupMs = seconds(env.MERGERON_BROWSER_STARTUP_SECONDS, 90, 10, 300);
    this.idleSince = now(); // Restart grace lets the application's live leases reconnect.
  }
  get busy() {
    return this.mutating;
  }
  exclusive(fn) {
    const next = (this.task ?? Promise.resolve()).catch(() => {}).then(fn);
    this.task = next;
    return next.finally(() => {
      if (this.task === next) this.task = null;
    });
  }
  async inspect() {
    const c = this.component;
    if (!c) return null;
    let item;
    try {
      item = await this.docker.inspectContainer(c.canonicalName);
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
    const labels = item.Config?.Labels ?? {};
    const host = item.HostConfig ?? {};
    const networks = Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
    const image = await this.docker.inspectImage(item.Image);
    const repository = (ref) =>
      String(ref)
        .split('@')[0]
        .replace(/:[^/:]+$/, '');
    const trustedImage = [
      item.Config?.Image,
      ...(image.RepoTags ?? []),
      ...(image.RepoDigests ?? []),
    ].some((ref) => c.allowedImageRepositories.includes(repository(ref)));
    if (
      item.Name !== `/${c.canonicalName}` ||
      labels['io.mergeron.managed'] !== 'true' ||
      labels['io.mergeron.component'] !== 'browser' ||
      labels['io.mergeron.stack'] !== this.manifest.stack ||
      !trustedImage ||
      image.Id !== item.Image ||
      host.Privileged ||
      host.NetworkMode !==
        c.requiredNetworks.find((name) => name.endsWith('-browser-control')) ||
      item.Config.User !== 'pwuser' ||
      !host.ReadonlyRootfs ||
      JSON.stringify(host.Dns ?? []) !== JSON.stringify(c.dns ?? ['1.1.1.1']) ||
      !host.CapDrop?.includes('ALL') ||
      host.CapAdd?.length ||
      Object.keys(host.PortBindings ?? {}).length ||
      item.Mounts?.length ||
      !host.SecurityOpt?.includes('no-new-privileges:true') ||
      !host.SecurityOpt?.some(
        (s) => s.startsWith('seccomp=') && !s.includes('unconfined'),
      ) ||
      !/^BROWSER_WS_PATH=[A-Za-z0-9_-]{32,128}$/.test(
        item.Config.Env?.find((e) => e.startsWith('BROWSER_WS_PATH=')) ?? '',
      ) ||
      !item.Config.Healthcheck?.Test?.length ||
      item.Config.Healthcheck.Test[0] === 'NONE' ||
      JSON.stringify(networks) !==
        JSON.stringify([...c.requiredNetworks].sort())
    )
      throw Error('BROWSER_RUNTIME_ISOLATION');
    for (const name of c.requiredNetworks) {
      const network = await this.docker.inspectNetwork(name);
      if (
        network.Name !== name ||
        network.Driver !== 'bridge' ||
        network.Internal !== name.endsWith('-browser-control')
      )
        throw Error('BROWSER_RUNTIME_ISOLATION');
    }
    return item;
  }
  prune() {
    const count = this.leases.size;
    for (const [id, expires] of this.leases)
      if (expires <= this.now()) this.leases.delete(id);
    if (count && !this.leases.size) this.idleSince = this.now();
  }
  async status() {
    this.prune();
    if (!this.component) return { state: 'external', activeLeases: 0 };
    try {
      const item = await this.inspect();
      let state = !item
        ? 'missing'
        : !item.State?.Running
          ? 'stopped'
          : item.State.Health?.Status === 'healthy'
            ? 'ready'
            : 'starting';
      if (item?.State?.Health?.Status === 'unhealthy' && item.State.Running) {
        state = 'error';
        this.error = 'BROWSER_RUNTIME_UNHEALTHY';
      }
      if (
        state === 'starting' &&
        this.startedAt !== null &&
        this.now() - this.startedAt >= this.startupMs
      ) {
        state = 'error';
        this.error = 'BROWSER_RUNTIME_START_TIMEOUT';
      }
      if (state === 'ready') {
        this.error = null;
        this.startedAt = null;
      }
      return {
        state,
        activeLeases: this.leases.size,
        idleSeconds: this.idleMs / 1000,
        startupSeconds: this.startupMs / 1000,
        error: state === 'error' ? this.error : null,
      };
    } catch {
      return {
        state: 'error',
        activeLeases: this.leases.size,
        error: 'BROWSER_RUNTIME_ISOLATION',
      };
    }
  }
  async lease(input = {}) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['owner', 'release'].includes(key))
    )
      throw Error('BROWSER_RUNTIME_INVALID_REQUEST');
    const { owner, release = false } = input;
    if (
      typeof owner !== 'string' ||
      !leasePattern.test(owner ?? '') ||
      typeof release !== 'boolean'
    )
      throw Error('BROWSER_RUNTIME_INVALID_REQUEST');
    return this.exclusive(async () => {
      this.prune();
      const key = createHash('sha256').update(owner).digest('hex');
      if (release) {
        const removed = this.leases.delete(key);
        if (removed && !this.leases.size) this.idleSince = this.now();
        return this.status();
      }
      if (!this.component) return { state: 'external', activeLeases: 0 };
      if (this.blocked()) throw Error('BROWSER_RUNTIME_BUSY');
      if (!this.leases.has(key) && this.leases.size >= 64)
        throw Error('BROWSER_RUNTIME_BUSY');
      const item = await this.inspect();
      if (!item) throw Error('BROWSER_RUNTIME_MISSING');
      const retry =
        !this.leases.has(key) && this.error === 'BROWSER_RUNTIME_START_TIMEOUT';
      this.leases.set(key, this.now() + 90_000);
      if (retry) {
        this.startedAt = this.now();
        this.error = null;
      }
      if (!item.State.Running) {
        this.startedAt = this.now();
        this.error = null;
        if (this.blocked()) throw Error('BROWSER_RUNTIME_BUSY');
        this.mutating = true;
        try {
          await this.docker.startContainer(item.Id);
        } finally {
          this.mutating = false;
        }
      } else if (
        item.State.Health?.Status !== 'healthy' &&
        this.startedAt === null
      ) {
        this.startedAt = this.now();
      }
      return this.status();
    });
  }
  async tick() {
    return this.exclusive(async () => {
      this.prune();
      if (
        !this.component ||
        this.blocked() ||
        this.leases.size ||
        this.now() - this.idleSince < this.idleMs
      )
        return;
      const item = await this.inspect();
      if (item?.State?.Running) {
        if (this.blocked()) return;
        this.mutating = true;
        try {
          await this.docker.stopContainer(item.Id, 15);
        } finally {
          this.mutating = false;
        }
      }
      this.startedAt = null;
    });
  }
}
