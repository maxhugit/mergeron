/** Generic preview orchestration: approved immutable images, no agent Docker API. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import contract from '../../runtime/preview-profile.cjs';
import archives from '../../runtime/preview-archive.cjs';
import { probePreview } from './preview-health.mjs';

const label = 'io.mergeron.preview';
const digest = /^.+@sha256:[a-f0-9]{64}$/;
const states = ['starting', 'running', 'failed', 'stopped'];
const fail = (code) => {
  throw new Error(code);
};
const missing = (e) => e?.statusCode === 404;
const code = (e, fallback) =>
  /^PREVIEW_[A-Z_]+$/.test(e?.message) ? e.message : fallback;
export function previewCatalog(env = process.env) {
  if (env.MERGERON_PREVIEWS_ENABLED !== 'true') return {};
  const data = JSON.parse(env.MERGERON_PREVIEW_IMAGES || '{}');
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length > 16
  )
    fail('PREVIEW_INVALID_CATALOG');
  for (const [key, v] of Object.entries(data)) {
    if (
      !/^[a-z][a-z0-9-]{0,39}$/.test(key) ||
      !v ||
      typeof v !== 'object' ||
      Object.keys(v).some(
        (k) => !['image', 'description', 'user', 'tmpfs'].includes(k),
      ) ||
      !digest.test(v.image) ||
      !/^[1-9]\d{0,5}:[1-9]\d{0,5}$/.test(v.user ?? '11002:11002') ||
      (v.description !== undefined &&
        (typeof v.description !== 'string' || v.description.length > 200))
    )
      fail('PREVIEW_INVALID_CATALOG');
    if (
      v.tmpfs !== undefined &&
      (!Array.isArray(v.tmpfs) ||
        v.tmpfs.length > 4 ||
        v.tmpfs.some(
          (p) =>
            typeof p !== 'string' ||
            !/^\/(?:data|var\/lib\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+){0,2}|run\/[a-zA-Z0-9_-]+)$/.test(
              p,
            ),
        ))
    )
      fail('PREVIEW_INVALID_CATALOG');
  }
  return data;
}
export class PreviewManager {
  constructor({
    docker,
    manifest,
    configuration,
    env = process.env,
    self = process.env.HOSTNAME,
    probe = probePreview,
  }) {
    Object.assign(this, { docker, manifest, configuration, env, self, probe });
    this.catalog = previewCatalog(env);
    this.domain = env.MERGERON_PREVIEW_DOMAIN ?? '';
    if (
      this.domain &&
      (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        this.domain,
      ) ||
        this.domain.length > 180)
    )
      fail('PREVIEW_INVALID_DOMAIN');
    if (this.domain && configuration.publicUrl) {
      const host = new URL(configuration.publicUrl).hostname;
      if (host === this.domain || host.endsWith('.' + this.domain))
        fail('PREVIEW_DOMAIN_OVERLAPS_APPLICATION');
    }
    this.busy = false;
    this.records = new Map();
    this.location =
      configuration.previewJournal ??
      path.join(
        path.dirname(
          configuration.adoptionPath ??
            '/var/lib/mergeron-manager/adoption.json',
        ),
        'previews',
      );
    this.ready = this.recover();
  }
  capabilities() {
    return {
      enabled: !!this.domain && Object.keys(this.catalog).length > 0,
      domain: this.domain || null,
      runtimes: Object.entries(this.catalog).map(([id, v]) => ({
        id,
        description: v.description ?? id,
        image: v.image,
      })),
      maxActive: 2,
      maxLifetimeMinutes: 240,
      synchronization: 'filtered-copy',
      data: 'ephemeral',
    };
  }
  async recover() {
    fs.mkdirSync(this.location, { recursive: true, mode: 0o700 });
    if (
      fs.lstatSync(this.location).isSymbolicLink() ||
      fs.realpathSync(this.location) !== path.resolve(this.location)
    )
      fail('PREVIEW_UNSAFE_JOURNAL');
    const files = fs.readdirSync(this.location);
    if (files.length > 2000) fail('PREVIEW_JOURNAL_LIMIT');
    for (const name of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = path.join(this.location, name),
        st = fs.lstatSync(file);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.nlink !== 1 ||
        st.size > 8 * 1024 ** 2
      )
        fail('PREVIEW_UNSAFE_JOURNAL');
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        !contract.RUN_ID.test(r.runId) ||
        name !== r.runId + '.json' ||
        typeof r.projectId !== 'string' ||
        !contract.ID.test(r.projectId) ||
        typeof r.agentId !== 'string' ||
        !contract.ID.test(r.agentId) ||
        !states.includes(r.state) ||
        !Array.isArray(r.objects) ||
        !Array.isArray(r.volumes) ||
        !Array.isArray(r.networks) ||
        !Array.isArray(r.entries) ||
        !Number.isFinite(r.expiresAt)
      )
        fail('PREVIEW_UNSAFE_JOURNAL');
      this.records.set(r.runId, r);
      if (r.state === 'starting') {
        // A crash during creation is not a successful launch. Reconcile only
        // this journaled run and remove its exact, independently labelled objects.
        await this.reconcile(r);
        await this.cleanup(r);
        r.state = 'failed';
        r.error = 'PREVIEW_INTERRUPTED';
        this.save(r);
      }
    }
  }
  save(r) {
    const target = path.join(this.location, r.runId + '.json'),
      tmp = target + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(r));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    const directory = fs.openSync(
      this.location,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    this.records.set(r.runId, r);
  }
  prefix(r) {
    return `${this.manifest.stack}-preview-${r.runId}`;
  }
  labels(r) {
    return { [label]: r.runId, 'io.mergeron.stack': this.manifest.stack };
  }
  hasLabels(value, r) {
    return (
      value?.[label] === r.runId &&
      value?.['io.mergeron.stack'] === this.manifest.stack
    );
  }
  async owned(id, r, component) {
    const c = await this.docker.inspectContainer(id);
    if (
      !this.hasLabels(c.Config?.Labels, r) ||
      c.Config.Labels['io.mergeron.component'] !== component
    )
      fail('PREVIEW_OBJECT_CHANGED');
    return c;
  }
  async reconcile(r) {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [
          `${label}=${r.runId}`,
          `io.mergeron.stack=${this.manifest.stack}`,
        ],
      }),
    );
    for (const c of await this.docker.request(
      '/containers/json?all=true&filters=' + filters,
    )) {
      const name = c.Names?.find((n) =>
        n.startsWith('/' + this.prefix(r) + '-'),
      )?.slice(1);
      const component = c.Labels?.['io.mergeron.component'];
      if (
        !name ||
        !this.hasLabels(c.Labels, r) ||
        component !== 'preview-' + name.slice((this.prefix(r) + '-').length)
      )
        fail('PREVIEW_OBJECT_CHANGED');
      if (!r.objects.some((o) => o.id === c.Id))
        r.objects.push({ id: c.Id, component, name });
    }
    for (const n of await this.docker.request('/networks?filters=' + filters)) {
      if (
        !this.hasLabels(n.Labels, r) ||
        !n.Name.startsWith(this.prefix(r) + '-')
      )
        fail('PREVIEW_OBJECT_CHANGED');
      if (!r.networks.includes(n.Name)) r.networks.push(n.Name);
    }
    for (const v of (await this.docker.request('/volumes?filters=' + filters))
      .Volumes ?? []) {
      if (
        !this.hasLabels(v.Labels, r) ||
        !v.Name.startsWith(this.prefix(r) + '-')
      )
        fail('PREVIEW_OBJECT_CHANGED');
      if (!r.volumes.includes(v.Name)) r.volumes.push(v.Name);
    }
    this.save(r);
  }
  base(network, memoryMb = 128, cpus = 1) {
    return {
      NetworkMode: network,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 128,
      Memory: memoryMb * 1024 ** 2,
      NanoCpus: cpus * 1e9,
      Dns: ['127.0.0.1'],
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '1m', 'max-file': '2' },
      },
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777',
        '/run/mergeron-manager': 'ro,nosuid,nodev,size=1m,mode=0000',
        '/var/lib/mergeron-manager': 'ro,nosuid,nodev,size=1m,mode=0000',
      },
    };
  }
  async add(r, suffix, image, spec, networks = []) {
    const name = this.prefix(r) + '-' + suffix;
    const c = await this.docker.createContainer(name, {
      Image: image,
      User: '11002:11002',
      Labels: {
        ...this.labels(r),
        'io.mergeron.component': 'preview-' + suffix,
      },
      HostConfig: this.base(networks[0] ?? 'none'),
      ...(networks.length
        ? {
            NetworkingConfig: {
              EndpointsConfig: Object.fromEntries(
                networks.map((n) => [
                  n,
                  {
                    Aliases:
                      suffix === 'relay' ? [this.relayAlias(r)] : [suffix],
                  },
                ]),
              ),
            },
          }
        : {}),
      ...spec,
    });
    r.objects.push({ id: c.Id, name, component: 'preview-' + suffix });
    this.save(r);
    return c.Id;
  }
  relayAlias(r) {
    // Docker DNS labels are limited to 63 characters, regardless of stack name.
    return `pv-${r.runId.replaceAll('-', '')}-relay`;
  }
  async volume(r, suffix) {
    const name = this.prefix(r) + '-' + suffix;
    const options = {
      type: 'tmpfs',
      device: 'tmpfs',
      o: `size=${suffix === 'source' ? 1024 : suffix === 'data' ? 128 : suffix.startsWith('control-') ? 16 : 64}m,nosuid,nodev,uid=11002,gid=11002,mode=0700`,
    };
    const v = await this.docker.request('/volumes/create', {
      method: 'POST',
      body: {
        Name: name,
        Labels: this.labels(r),
        Driver: 'local',
        DriverOpts: options,
      },
    });
    if (
      v.Name !== name ||
      !this.hasLabels(v.Labels, r) ||
      v.Driver !== 'local' ||
      Object.entries(options).some(([k, value]) => v.Options?.[k] !== value)
    )
      fail('PREVIEW_UNSAFE_VOLUME');
    r.volumes.push(name);
    this.save(r);
    return name;
  }
  async removeObject(r, item) {
    try {
      const c = await this.owned(item.id, r, item.component);
      if (c.State?.Running) await this.docker.stopContainer(item.id, 3);
      await this.docker.removeContainer(item.id);
    } catch (e) {
      if (!missing(e)) throw e;
    }
    r.objects = r.objects.filter((c) => c.id !== item.id);
    this.save(r);
  }
  snapshot(r, snapshotId, sha) {
    if (!contract.RUN_ID.test(snapshotId) || !/^[a-f0-9]{64}$/.test(sha))
      fail('PREVIEW_INVALID_REQUEST');
    let root = this.configuration.hostStatePath;
    if (fs.realpathSync(root) !== path.resolve(root))
      fail('PREVIEW_UNSAFE_SNAPSHOT');
    for (const part of [
      'workspace',
      '.mergeron-system',
      r.projectId,
      'previews',
      snapshotId,
    ]) {
      root = path.join(root, part);
      const st = fs.lstatSync(root);
      if (!st.isDirectory() || st.isSymbolicLink())
        fail('PREVIEW_UNSAFE_SNAPSHOT');
    }
    const fd = fs.openSync(
      path.join(root, 'source.tar'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let archive;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 64 * 1024 ** 2)
        fail('PREVIEW_UNSAFE_SNAPSHOT');
      archive = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (createHash('sha256').update(archive).digest('hex') !== sha)
      fail('PREVIEW_STALE_SNAPSHOT');
    return {
      archive,
      entries: archives.entries(archive).filter((v) => v.type === 'file'),
    };
  }
  async apply(r, snapshotId, sha) {
    const { archive, entries } = this.snapshot(r, snapshotId, sha);
    const input = await this.volume(
      r,
      'input-' + randomBytes(4).toString('hex'),
    );
    const control = await this.volume(
      r,
      'control-' + randomBytes(4).toString('hex'),
    );
    const suffix = 'sync-' + randomBytes(4).toString('hex');
    const id = await this.add(r, suffix, r.helperImage, {
      Entrypoint: ['/nodejs/bin/node'],
      WorkingDir: '/opt/mergeron-manager',
      Cmd: ['src/preview-sync.mjs'],
      HostConfig: {
        ...this.base('none', 256),
        Mounts: [
          { Type: 'volume', Source: input, Target: '/workspace' },
          { Type: 'volume', Source: r.sourceVolume, Target: '/target' },
          { Type: 'volume', Source: control, Target: '/control' },
        ],
      },
    });
    const newNames = new Set(entries.map((v) => v.name));
    const removed = r.entries
      .filter((v) => !newNames.has(v.name))
      .map((v) => v.name);
    await this.docker.startContainer(id);
    await this.docker.putArchive(id, archive);
    await this.docker.putArchive(
      id,
      archives.jsonArchive({ entries, removed }),
      '/control',
    );
    await this.docker.putArchive(
      id,
      archives.jsonArchive(true, 'ready'),
      '/control',
    );
    if ((await this.docker.waitContainer(id, 45000)).StatusCode !== 0)
      fail('PREVIEW_SYNC_FAILED');
    await this.removeObject(
      r,
      r.objects.find((c) => c.id === id),
    );
    await this.removeVolume(r, input);
    await this.removeVolume(r, control);
    const dependencies =
      /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock)$/;
    const old = new Map(r.entries.map((v) => [v.name, v.sha256]));
    const dependenciesChanged =
      r.entries.length > 0 &&
      (removed.some((n) => dependencies.test(n)) ||
        entries.some(
          (v) => dependencies.test(v.name) && old.get(v.name) !== v.sha256,
        ));
    r.entries = entries;
    r.sourceSha = sha;
    r.lastSyncedAt = Date.now();
    r.error = null;
    r.requiresRestart = dependenciesChanged || r.requiresRestart || false;
    this.save(r);
    return { dependenciesChanged };
  }
  async start(input) {
    await this.ready;
    if (!this.capabilities().enabled) fail('PREVIEW_NOT_CONFIGURED');
    if (this.busy) fail('PREVIEW_BUSY');
    for (const k of ['projectId', 'agentId'])
      if (typeof input?.[k] !== 'string' || !contract.ID.test(input[k]))
        fail('PREVIEW_INVALID_REQUEST');
    if (
      !contract.RUN_ID.test(input?.runId) ||
      !contract.RUN_ID.test(input?.previewId) ||
      !/^[a-f0-9]{64}$/.test(input?.sourceSha)
    )
      fail('PREVIEW_INVALID_REQUEST');
    const profile = contract.profile(input.profile);
    if (!profile.enabled || !profile.start.trim()) fail('PREVIEW_DISABLED');
    for (const key of [
      profile.runtime,
      ...profile.services.map((v) => v.runtime),
    ])
      if (!Object.hasOwn(this.catalog, key))
        fail('PREVIEW_RUNTIME_NOT_APPROVED');
    if ((this.catalog[profile.runtime].user ?? '11002:11002') !== '11002:11002')
      fail('PREVIEW_RUNTIME_USER_UNSUPPORTED');
    const fingerprint = contract.fingerprint({
      projectId: input.projectId,
      agentId: input.agentId,
      previewId: input.previewId,
      sourceSha: input.sourceSha,
      profile,
    });
    const previous = this.records.get(input.runId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        fail('PREVIEW_REQUEST_CONFLICT');
      return this.status(previous.runId);
    }
    const active = [...this.records.values()].filter(
      (r) => r.objects.length || ['starting', 'running'].includes(r.state),
    );
    if (
      active.some(
        (r) => r.projectId === input.projectId && r.agentId === input.agentId,
      )
    )
      fail('PREVIEW_ALREADY_RUNNING');
    if (active.length >= 2) fail('PREVIEW_CAPACITY');
    if (this.records.size >= 1000) fail('PREVIEW_JOURNAL_LIMIT');
    this.busy = true;
    const r = {
      runId: input.runId,
      previewId: input.previewId,
      projectId: input.projectId,
      agentId: input.agentId,
      fingerprint,
      state: 'starting',
      createdAt: Date.now(),
      expiresAt: Date.now() + profile.lifetimeMinutes * 60000,
      objects: [],
      volumes: [],
      networks: [],
      entries: [],
      updateMode: profile.updateMode,
      path: profile.path,
      publicHost: input.runId + '.' + this.domain,
    };
    try {
      this.save(r);
      const version = await this.docker.request('/version');
      if (
        !/^\d+\./.test(version.Version) ||
        Number(version.Version.split('.')[0]) < 28
      )
        fail('PREVIEW_DOCKER_UPGRADE_REQUIRED');
      const app = await this.docker.inspectContainer(
        this.manifest.components.find((c) => c.id === 'application')
          .canonicalName,
      );
      const mount = app.Mounts?.find((m) => m.Destination === '/workspaces');
      if (
        app.Config?.Labels?.['io.mergeron.managed'] !== 'true' ||
        app.Config.Labels['io.mergeron.stack'] !== this.manifest.stack ||
        app.Config.Labels['io.mergeron.component'] !== 'application' ||
        mount?.Type !== 'bind' ||
        mount.Source !== this.configuration.stateRoot + '/workspace'
      )
        fail('PREVIEW_APPLICATION_NOT_MANAGED');
      const own = await this.docker.inspectContainer(this.self);
      if (
        !/^sha256:[a-f0-9]{64}$/.test(own.Image) ||
        own.Config?.Labels?.['io.mergeron.component'] !== 'manager' ||
        own.Config.Labels['io.mergeron.stack'] !== this.manifest.stack
      )
        fail('PREVIEW_MANAGER_IDENTITY');
      r.helperImage = own.Image;
      if (
        Object.keys(own.Config.Volumes ?? {}).some(
          (p) => !Object.hasOwn(this.base('none').Tmpfs, p),
        )
      )
        fail('PREVIEW_HELPER_VOLUMES_UNSUPPORTED');
      this.save(r);
      for (const key of new Set([
        profile.runtime,
        ...profile.services.map((v) => v.runtime),
      ])) {
        const approved = this.catalog[key],
          image = await this.docker.inspectImage(approved.image);
        if (image.Os !== 'linux') fail('PREVIEW_IMAGE_UNSUPPORTED');
        const declared = Object.keys(image.Config?.Volumes ?? {});
        const covered =
          key === profile.runtime
            ? ['/workspace', '/data', '/tmp']
            : [...(approved.tmpfs ?? ['/data']), '/tmp'];
        if (declared.some((p) => !covered.includes(p)))
          fail('PREVIEW_IMAGE_VOLUMES_REQUIRE_CONFIGURATION');
      }
      // Validate the source before creating any Docker resources.
      this.snapshot(r, r.runId, input.sourceSha);
      const internal = this.prefix(r) + '-private',
        external = this.prefix(r) + '-egress';
      for (const [name, isolated] of [
        [internal, true],
        [external, false],
      ]) {
        await this.docker.createNetwork({
          Name: name,
          Driver: 'bridge',
          Internal: isolated,
          Labels: this.labels(r),
          ...(isolated
            ? {
                Options: {
                  'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
                  'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
                },
              }
            : {}),
        });
        r.networks.push(name);
        this.save(r);
        const network = await this.docker.inspectNetwork(name);
        if (
          !this.hasLabels(network.Labels, r) ||
          network.Driver !== 'bridge' ||
          (isolated &&
            (!network.Internal ||
              network.Options?.[
                'com.docker.network.bridge.gateway_mode_ipv4'
              ] !== 'isolated'))
        )
          fail('PREVIEW_NETWORK_UNSAFE');
      }
      r.sourceVolume = await this.volume(r, 'source');
      r.dataVolume = await this.volume(r, 'data');
      this.save(r);
      // Keep the bounded tmpfs source volume mounted between atomic sync jobs.
      // No host directory, root initializer or unbounded local data volume.
      const keeper = await this.add(r, 'volume', r.helperImage, {
        Entrypoint: ['/nodejs/bin/node'],
        WorkingDir: '/opt/mergeron-manager',
        Cmd: ['src/preview-volume.mjs'],
        HostConfig: {
          ...this.base('none', 64),
          Mounts: [
            {
              Type: 'volume',
              Source: r.sourceVolume,
              Target: '/target',
              ReadOnly: true,
            },
            {
              Type: 'volume',
              Source: r.dataVolume,
              Target: '/data',
              ReadOnly: true,
            },
          ],
        },
      });
      await this.docker.startContainer(keeper);
      await this.apply(r, r.runId, input.sourceSha);
      const proxy = await this.add(
        r,
        'egress',
        r.helperImage,
        {
          Entrypoint: ['/nodejs/bin/node'],
          WorkingDir: '/opt/mergeron-manager',
          Cmd: ['src/preview-egress.mjs'],
          Env: [
            'MERGERON_PREVIEW_ALLOWED_DOMAINS=' +
              (this.env.MERGERON_PREVIEW_ALLOWED_DOMAINS ??
                'registry.npmjs.org,pypi.org,files.pythonhosted.org,github.com,codeload.github.com,raw.githubusercontent.com'),
          ],
          HostConfig: { ...this.base(external), Dns: [] },
        },
        [external, internal],
      );
      await this.docker.startContainer(proxy);
      for (const service of profile.services) {
        const approved = this.catalog[service.runtime],
          user = approved.user ?? '11002:11002',
          [uid, gid] = user.split(':');
        const tmpfs = Object.fromEntries(
          (approved.tmpfs ?? ['/data']).map((p) => [
            p,
            `rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid},mode=700`,
          ]),
        );
        const id = await this.add(
          r,
          service.name,
          approved.image,
          {
            User: user,
            ...(service.command
              ? { Entrypoint: ['/bin/sh', '-c'], Cmd: [service.command] }
              : {}),
            Env: Object.entries(service.env).map(([k, v]) => `${k}=${v}`),
            HostConfig: {
              ...this.base(internal, 256),
              Tmpfs: { ...this.base(internal).Tmpfs, ...tmpfs },
            },
          },
          [internal],
        );
        await this.docker.startContainer(id);
      }
      const runtime = await this.add(
        r,
        'app',
        this.catalog[profile.runtime].image,
        {
          Entrypoint: ['/bin/sh', '-c'],
          Cmd: [
            'set -eu\n' +
              [profile.install, profile.build, profile.start]
                .filter((s) => s.trim())
                .join('\n'),
          ],
          WorkingDir:
            '/workspace' +
            (profile.directory === '.' ? '' : '/' + profile.directory),
          Env: [
            'HOME=/tmp',
            'HTTP_PROXY=http://egress:3129',
            'HTTPS_PROXY=http://egress:3129',
            'http_proxy=http://egress:3129',
            'https_proxy=http://egress:3129',
            'NO_PROXY=localhost,127.0.0.1,app,' +
              profile.services.map((s) => s.name).join(','),
            'PORT=' + profile.port,
            '__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=' + r.publicHost,
            ...Object.entries(profile.env).map(([k, v]) => `${k}=${v}`),
          ],
          HostConfig: {
            ...this.base(internal, profile.memoryMb, profile.cpus),
            PidsLimit: 256,
            Mounts: [
              { Type: 'volume', Source: r.sourceVolume, Target: '/workspace' },
              { Type: 'volume', Source: r.dataVolume, Target: '/data' },
            ],
            Tmpfs: {
              '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777',
            },
          },
        },
        [internal],
      );
      r.runtimeId = runtime;
      this.save(r);
      await this.docker.startContainer(runtime);
      const token = randomBytes(32).toString('hex'),
        admin = this.manifest.networks.find((n) => n.id === 'admin').name;
      const relay = await this.add(
        r,
        'relay',
        r.helperImage,
        {
          Entrypoint: ['/nodejs/bin/node'],
          WorkingDir: '/opt/mergeron-manager',
          Cmd: ['src/preview-relay.mjs'],
          Env: [
            `MERGERON_PREVIEW_TARGET=http://app:${profile.port}`,
            `MERGERON_PREVIEW_TRANSPORT_TOKEN=${token}`,
            `MERGERON_PREVIEW_PUBLIC_HOST=${r.publicHost}`,
          ],
        },
        [admin, internal],
      );
      await this.docker.startContainer(relay);
      Object.assign(r, {
        state: 'running',
        endpoint: `http://${this.relayAlias(r)}:8180`,
        transportToken: token,
      });
      this.save(r);
    } catch (e) {
      r.state = 'failed';
      r.error = code(e, 'PREVIEW_START_FAILED');
      this.save(r);
      await this.reconcile(r)
        .then(() => this.cleanup(r))
        .catch(() => {
          r.error = 'PREVIEW_CLEANUP_REQUIRED';
          this.save(r);
        });
      fail(r.error);
    } finally {
      this.busy = false;
    }
    return this.status(r.runId);
  }
  async sync(input) {
    await this.ready;
    const r = this.records.get(input?.runId);
    if (!r || r.state !== 'running') fail('PREVIEW_NOT_RUNNING');
    if (this.busy) fail('PREVIEW_BUSY');
    if (r.sourceSha === input.sourceSha) return this.status(r.runId);
    this.busy = true;
    try {
      await this.cleanupTransfers(r);
      await this.owned(r.runtimeId, r, 'preview-app');
      await this.apply(r, input.snapshotId, input.sourceSha);
      if (r.updateMode === 'restart') {
        await this.docker.stopContainer(r.runtimeId, 3);
        await this.docker.startContainer(r.runtimeId);
        r.requiresRestart = false;
        this.save(r);
      }
    } catch (e) {
      r.error = code(e, 'PREVIEW_SYNC_FAILED');
      this.save(r);
      throw new Error(r.error);
    } finally {
      try {
        await this.cleanupTransfers(r);
      } catch {
        r.error = 'PREVIEW_CLEANUP_REQUIRED';
        this.save(r);
      }
      this.busy = false;
    }
    return this.status(r.runId);
  }
  async status(runId, checkHttp = true) {
    await this.ready;
    const r = this.records.get(runId);
    if (!r) fail('PREVIEW_NOT_FOUND');
    if (r.state === 'running' && r.expiresAt <= Date.now() && !this.busy)
      await this.stop(runId);
    if (r.state === 'running') {
      const runtime = await this.owned(r.runtimeId, r, 'preview-app');
      if (!runtime.State?.Running) {
        r.state = 'failed';
        r.error = 'PREVIEW_PROCESS_EXITED';
        this.save(r);
      }
    }
    const health =
      r.state === 'running' && checkHttp
        ? await this.probe({
            runId: r.runId,
            domain: this.domain,
            path: r.path,
            token: r.transportToken,
          })
        : { ready: false, httpStatus: null };
    return {
      runId: r.runId,
      previewId: r.previewId,
      projectId: r.projectId,
      agentId: r.agentId,
      state: r.state,
      error: r.error ?? null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      sourceSha: r.sourceSha,
      lastSyncedAt: r.lastSyncedAt ?? null,
      updateMode: r.updateMode,
      requiresRestart: r.requiresRestart ?? false,
      ready: health.ready === true,
      httpStatus: health.httpStatus,
      url:
        health.ready && r.publicHost
          ? 'https://' + r.publicHost + r.path
          : null,
    };
  }
  async transport(runId) {
    const status = await this.status(runId, false),
      r = this.records.get(runId);
    if (status.state !== 'running') fail('PREVIEW_NOT_RUNNING');
    await this.owned(
      r.objects.find((c) => c.component === 'preview-relay')?.id,
      r,
      'preview-relay',
    );
    return {
      ...status,
      endpoint: r.endpoint,
      token: r.transportToken,
      publicHost: r.publicHost,
    };
  }
  async logs(runId) {
    await this.status(runId);
    const r = this.records.get(runId);
    let text = '';
    const secrets = [];
    for (const c of r.objects.filter(
      (c) =>
        c.component === 'preview-app' ||
        !/^preview-(?:relay|egress|volume|sync-|init-)/.test(c.component),
    )) {
      const item = await this.owned(c.id, r, c.component);
      secrets.push(
        ...(item.Config.Env ?? [])
          .map((s) => s.slice(s.indexOf('=') + 1))
          .filter((s) => s.length >= 4),
      );
      text += (await this.docker.containerLogs(c.id)).slice(-32768);
    }
    for (const secret of secrets.sort((a, b) => b.length - a.length))
      text = text.split(secret).join('[redacted]');
    return { text: text.slice(-65536), untrustedContent: true };
  }
  async removeVolume(r, name) {
    try {
      const v = await this.docker.request(
        '/volumes/' + encodeURIComponent(name),
      );
      if (
        !this.hasLabels(v.Labels, r) ||
        !name.startsWith(this.prefix(r) + '-')
      )
        fail('PREVIEW_OBJECT_CHANGED');
      await this.docker.request('/volumes/' + encodeURIComponent(name), {
        method: 'DELETE',
      });
    } catch (e) {
      if (!missing(e)) throw e;
    }
    r.volumes = r.volumes.filter((v) => v !== name);
    this.save(r);
  }
  async cleanupTransfers(r) {
    for (const item of [...r.objects]
      .filter((c) => /^preview-(?:sync-|init-)/.test(c.component))
      .reverse())
      await this.removeObject(r, item);
    for (const name of [...r.volumes].filter(
      (n) =>
        n.startsWith(this.prefix(r) + '-input-') ||
        n.startsWith(this.prefix(r) + '-control-'),
    ))
      await this.removeVolume(r, name);
  }
  async cleanup(r) {
    for (const c of [...r.objects].reverse()) await this.removeObject(r, c);
    for (const name of [...r.volumes]) await this.removeVolume(r, name);
    for (const name of [...r.networks].reverse()) {
      try {
        const n = await this.docker.inspectNetwork(name);
        if (
          !this.hasLabels(n.Labels, r) ||
          !name.startsWith(this.prefix(r) + '-') ||
          Object.keys(n.Containers ?? {}).length
        )
          fail('PREVIEW_OBJECT_CHANGED');
        await this.docker.request('/networks/' + encodeURIComponent(name), {
          method: 'DELETE',
        });
      } catch (e) {
        if (!missing(e)) throw e;
      }
      r.networks = r.networks.filter((n) => n !== name);
      this.save(r);
    }
  }
  async stop(runId) {
    await this.ready;
    const r = this.records.get(runId);
    if (!r) fail('PREVIEW_NOT_FOUND');
    if (this.busy) fail('PREVIEW_BUSY');
    this.busy = true;
    try {
      await this.reconcile(r);
      await this.cleanup(r);
      r.state = 'stopped';
      this.save(r);
    } finally {
      this.busy = false;
    }
    return this.status(runId);
  }
  async expire() {
    await this.ready;
    if (this.busy) return;
    for (const r of this.records.values()) {
      if (
        (r.objects.length || ['starting', 'running'].includes(r.state)) &&
        r.expiresAt <= Date.now()
      )
        await this.stop(r.runId);
      else if (!r.objects.length && r.expiresAt < Date.now() - 86400000) {
        fs.unlinkSync(path.join(this.location, r.runId + '.json'));
        this.records.delete(r.runId);
      }
    }
  }
}
