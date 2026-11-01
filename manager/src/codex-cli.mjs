/** Manager installs only its own immutable, build-tested bundle. It never
 * downloads a URL from a request or activates a CLI behind the app's admission.
 */
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import runtime from '../../runtime/managed-cli.cjs';

function safeDirectory(base, relative) {
  let directory = base;
  for (const component of relative.split('/')) {
    directory = join(directory, component);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('codexRuntimeUnsafeHome');
  }
  return directory;
}

/** Runs only in an unprivileged, network-none helper with the managed home bind.
 * No Docker socket, credentials environment, application data or host paths are
 * accepted from an HTTP request. Selection is exclusively the app's job.
 */
export function installBundle(bundle, home, expected) {
  const data = runtime.verify(bundle, expected.manifestSha256);
  if (data.id !== expected.releaseId)
    throw new Error('codexRuntimePlanChanged');
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('codexRuntimeUnsafeHome');
  const cli = safeDirectory(home, '.codex/webui/cli');
  const releases = safeDirectory(cli, 'releases');
  const target = join(releases, data.id);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink())
      throw new Error('codexRuntimeUnsafeHome');
    runtime.verify(target, data.manifestSha256);
    return;
  }
  const staging = join(releases, `.install-${randomUUID()}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const entry of data.files) {
      const destination = join(staging, entry.path);
      fs.mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      // Bound userspace memory and dirty page cache even for the native binary.
      // A single copy_file_range can charge the entire dirty file to this
      // cgroup before fsync, killing a correctly constrained helper with OOM.
      const sourceFd = fs.openSync(
        runtime.within(bundle, entry.path),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      let destinationFd;
      try {
        destinationFd = fs.openSync(
          destination,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
        const chunk = Buffer.allocUnsafe(128 * 1024);
        let length,
          unsynced = 0;
        while ((length = fs.readSync(sourceFd, chunk, 0, chunk.length, null))) {
          let written = 0;
          while (written < length)
            written += fs.writeSync(
              destinationFd,
              chunk,
              written,
              length - written,
            );
          unsynced += length;
          if (unsynced >= 8 * 1024 ** 2) {
            fs.fdatasyncSync(destinationFd);
            unsynced = 0;
          }
        }
        fs.fsyncSync(destinationFd);
      } finally {
        fs.closeSync(sourceFd);
        if (destinationFd !== undefined) fs.closeSync(destinationFd);
      }
      fs.chmodSync(destination, entry.executable ? 0o555 : 0o444);
      const fd = fs.openSync(destination, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.copyFileSync(
      join(bundle, 'release.json'),
      join(staging, 'release.json'),
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(join(staging, 'release.json'), 0o444);
    fs.symlinkSync(data.native, join(staging, 'codex'));
    fs.mkdirSync(join(staging, 'helpers'), { mode: 0o755 });
    for (const name of [
      'codex',
      'apply_patch',
      'applypatch',
      'codex-execve-wrapper',
      'codex-linux-sandbox',
    ])
      fs.symlinkSync('../codex', join(staging, 'helpers', name));
    runtime.verify(staging, data.manifestSha256);
    fs.renameSync(staging, target);
    const fd = fs.openSync(releases, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    // Only this invocation's unique, never-activated staging directory.
    if (fs.existsSync(staging))
      fs.rmSync(staging, { recursive: true, force: true });
  }
}
export class ManagedCodexCli {
  constructor({
    docker,
    manifest,
    configuration,
    inventory,
    bundle = new URL('../codex-runtime', import.meta.url).pathname,
    self = process.env.HOSTNAME,
  }) {
    Object.assign(this, {
      docker,
      manifest,
      configuration,
      inventory,
      bundle,
      self,
    });
    this.busy = false;
  }
  status() {
    const data = runtime.verify(this.bundle);
    return {
      id: data.id,
      upstreamVersion: data.upstreamVersion,
      upstreamCommit: data.upstreamCommit,
      patchSha256: data.patchSha256,
      manifestSha256: data.manifestSha256,
      capabilities: data.capabilities,
      platform: data.platform,
      arch: data.arch,
    };
  }
  async install(input) {
    if (this.busy) throw new Error('managerOperationInProgress');
    this.busy = true;
    let helper;
    try {
      const data = this.status();
      if (
        input?.releaseId !== data.id ||
        input?.manifestSha256 !== data.manifestSha256
      )
        throw new Error('codexRuntimePlanChanged');
      const component = this.manifest.components.find(
        (c) => c.id === 'application',
      );
      const app = await this.docker.inspectContainer(component.canonicalName);
      if (
        !app ||
        app.Config?.User !== '11002:11002' ||
        app.Name !== `/${component.canonicalName}`
      )
        throw new Error('codexRuntimeApplicationNotManaged');
      const labels = app.Config.Labels ?? {};
      const ownershipKeys = [
        'io.mergeron.managed',
        'io.mergeron.stack',
        'io.mergeron.component',
      ];
      const labeled =
        labels[ownershipKeys[0]] === 'true' &&
        labels[ownershipKeys[1]] === this.manifest.stack &&
        labels[ownershipKeys[2]] === 'application';
      if (!labeled) {
        // Historical installations are explicitly adopted without rewriting Docker labels.
        // Never forgive conflicting ownership labels or a stale adoption fingerprint.
        const unlabeled = ownershipKeys.every(
          (key) => labels[key] === undefined,
        );
        const inventory =
          unlabeled && this.inventory
            ? await this.inventory().catch(() => null)
            : null;
        const adopted = inventory?.components?.find(
          (entry) => entry.id === 'application',
        );
        if (
          inventory?.stack !== this.manifest.stack ||
          inventory.adoption?.state !== 'adopted' ||
          inventory.adoption.blockers?.length !== 0 ||
          inventory.dataSafety?.status !== 'protected' ||
          adopted?.adoption !== 'managed' ||
          adopted.containerId !== app.Id ||
          adopted.containerName !== component.canonicalName ||
          adopted.image !== app.Config.Image ||
          adopted.imageRepositoryAllowed !== true
        )
          throw new Error('codexRuntimeApplicationNotManaged');
      }
      const mount = app.Mounts?.find((m) => m.Destination === '/home/codex');
      if (
        mount?.Type !== 'bind' ||
        !mount.RW ||
        mount.Source !== `${this.configuration.stateRoot}/home`
      )
        throw new Error('codexRuntimeUnsafeHome');
      const image = await this.docker.inspectImage(app.Image);
      if (
        image.Architecture !== 'amd64' ||
        image.Os !== 'linux' ||
        image.Config?.Labels?.['io.mergeron.cli-policy'] !== '1'
      )
        throw new Error('codexRuntimeApplicationUpgradeRequired');
      const own = await this.docker.inspectContainer(this.self);
      const ownImage = await this.docker.inspectImage(own.Image);
      if (
        !/^sha256:[a-f0-9]{64}$/.test(own.Image) ||
        ownImage.Config?.Labels?.['org.opencontainers.image.title'] !==
          'Mergeron Manager'
      )
        throw new Error('codexRuntimeManagerIdentityInvalid');
      const created = await this.docker.createContainer(
        `${this.manifest.stack}-cli-installer-${randomUUID()}`,
        {
          Image: own.Image,
          User: '11002:11002',
          Entrypoint: ['/nodejs/bin/node'],
          Cmd: ['src/install-cli-helper.mjs', data.id, data.manifestSha256],
          WorkingDir: '/opt/mergeron-manager',
          Env: ['NODE_ENV=production'],
          Labels: {
            'io.mergeron.stack': this.manifest.stack,
            'io.mergeron.component': 'cli-installer',
          },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            PidsLimit: 64,
            Memory: 512 * 1024 ** 2,
            Mounts: [
              {
                Type: 'bind',
                Source: mount.Source,
                Target: '/managed-home',
                ReadOnly: false,
              },
            ],
            Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=8m' },
          },
        },
      );
      helper = created.Id;
      await this.docker.startContainer(helper);
      const result = await this.docker.waitContainer(helper);
      if (result.StatusCode !== 0 || result.Error) {
        console.error('Managed CLI installer failed', {
          exitCode: result.StatusCode,
        });
        throw new Error('codexRuntimeInstallationFailed');
      }
      return { ...data, installed: true };
    } finally {
      try {
        if (helper) {
          const state = await this.docker.inspectContainer(helper);
          if (state.State.Running) await this.docker.stopContainer(helper);
          await this.docker.removeContainer(helper);
        }
      } finally {
        this.busy = false;
      }
    }
  }
}

/** Fail closed before an app image can remove the lifecycle guard. */
export function assertCliPolicyImage(configuration, image) {
  const home = join(configuration.hostStatePath, 'home', '.codex');
  const state = runtime.selection(home);
  if (
    (state.protection || runtime.legacyCustom(home, state)) &&
    image.Config?.Labels?.['io.mergeron.cli-policy'] !== '1'
  )
    throw new Error('updateCliProtectionRequired');
}

export function cliProtectionFingerprint(configuration) {
  const home = join(configuration.hostStatePath, 'home', '.codex');
  const state = runtime.selection(home);
  return (
    state.protection ??
    (runtime.legacyCustom(home, state) ? { legacyCustom: true } : null)
  );
}
