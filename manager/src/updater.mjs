import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  chmod,
  chown,
  lchown,
  lutimes,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rmdir,
  rename,
  rm,
  statfs,
  symlink,
  utimes,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { collectInventory } from './inventory.mjs';
import {
  installedImageBuild,
  inspectInstalledBuild,
} from './installed-build.mjs';
import {
  allocatedTreeSize,
  backupIdentity,
  readBackupSize,
} from './backup-size.mjs';
import { agentVisualSandbox } from './agent-visual-sandbox.mjs';
import {
  BACKUP_ARCHIVE_FORMAT,
  BACKUP_ARCHIVE_NAME,
  archiveDescriptor,
  createBackupArchive,
  extractBackupArchive,
} from './backup-archive.mjs';
import {
  persistentEntries as dataEntries,
  environmentBackupPolicy,
  recordedBackupPolicy,
  backupEntries,
  excludesBackupDirectory,
  updateConfirmation,
  rollbackConfirmation,
  MINIMAL,
  LEGACY_FULL,
  withoutDataBackup,
  minimalHomeEntries,
} from './backup-policy.mjs';
import {
  assertCliPolicyImage,
  cliProtectionFingerprint,
} from './codex-cli.mjs';
import {
  evaluateAdoption,
  readAdoptionRecord,
  inventoryFingerprint,
} from './adoption.mjs';

const terminal = new Set(['succeeded', 'rolledBack', 'cancelled']);

/** Only for a validated, durably discarded backup below the private Manager root.
 * CHOWN suffices: reclaim directories before chmod, without DAC_OVERRIDE/FOWNER.
 * Never change file ownership/modes (files may be hardlinked) or follow symlinks.
 */
async function removeDiscardedBackupTree(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('managerBackupInvalid');
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await directory.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error('managerBackupInvalid');
    if (opened.uid !== process.getuid())
      await directory.chown(process.getuid(), process.getgid());
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const entry = await lstat(child);
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await removeDiscardedBackupTree(child);
    else await unlink(child);
  }
  await rmdir(path);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const repository = (ref) =>
  String(ref)
    .split('@')[0]
    .replace(/:[^/:]+$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pinnedImage = (image, reference) => {
  const repo = repository(reference);
  const pinned = image.RepoDigests?.find((d) =>
    d.startsWith(`${repo}@sha256:`),
  );
  if (!pinned) throw new Error('updateImageDigestUnavailable');
  return pinned;
};

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function durableRename(source, destination) {
  await rename(source, destination);
  for (const path of new Set([dirname(source), dirname(destination)])) {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

// Never follow a symlink out of the state directory, or copy transient sockets.
// Set ownership last: the Manager intentionally does not have CAP_FOWNER.
export async function copyPersistentTree(
  source,
  destination,
  concurrency = 1,
  selection = null,
) {
  if (![1, 8].includes(concurrency))
    throw new Error('updateInvalidCopyConcurrency');
  const info = await lstat(source);
  if (
    info.isDirectory() &&
    selection &&
    excludesBackupDirectory(selection.policy, selection.path)
  )
    return;
  if (info.isSocket()) return;
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    await lutimes(destination, info.atime, info.mtime);
    await lchown(destination, info.uid, info.gid);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    const entries = await readdir(source, { withFileTypes: true });
    if (concurrency === 1) {
      for (const { name } of entries)
        await copyPersistentTree(
          join(source, name),
          join(destination, name),
          concurrency,
          selection && { ...selection, path: `${selection.path}/${name}` },
        );
    } else {
      // Subdirectories stay sequential: the limit is global, not multiplied at
      // every recursion level. Symlinks are still handled with lstat/no-follow.
      const files = entries.filter((entry) => !entry.isDirectory());
      for (let index = 0; index < files.length; index += concurrency) {
        const results = await Promise.allSettled(
          files.slice(index, index + concurrency).map(({ name }) =>
            copyPersistentTree(
              join(source, name),
              join(destination, name),
              concurrency,
              selection && {
                ...selection,
                path: `${selection.path}/${name}`,
              },
            ),
          ),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
      }
      for (const { name } of entries.filter((entry) => entry.isDirectory()))
        await copyPersistentTree(
          join(source, name),
          join(destination, name),
          concurrency,
          selection && { ...selection, path: `${selection.path}/${name}` },
        );
    }
  } else if (info.isFile()) {
    // libuv copyFile can change ownership before chmod on Linux, which would
    // need CAP_FOWNER. Stream into a root-owned exclusive file instead.
    await pipeline(
      createReadStream(source, {
        flags: constants.O_RDONLY | constants.O_NOFOLLOW,
      }),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
    const file = await open(destination, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  } else throw new Error('updateUnsupportedPersistentFile');
  await chmod(destination, info.mode & 0o7777);
  await utimes(destination, info.atime, info.mtime);
  await chown(destination, info.uid, info.gid);
  if (info.isDirectory()) {
    const directory = await open(destination, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function treeSize(path, selection = null) {
  const value = await lstat(path);
  if (value.isDirectory()) {
    if (selection && excludesBackupDirectory(selection.policy, selection.path))
      return 0;
    let total = 1024;
    for (const name of await readdir(path))
      total += await treeSize(
        join(path, name),
        selection && { ...selection, path: `${selection.path}/${name}` },
      );
    return total;
  }
  return value.isFile() ? value.size + 1024 : 1024;
}

export async function restorePersistentEntry(
  stateRoot,
  base,
  id,
  name,
  { allowMissing = false, backupRoot = join(base, 'backup') } = {},
) {
  const source = join(stateRoot, name);
  // Linux requires write permission on a directory when changing its parent.
  // Same-parent renames keep UID-11002 private directories intact without
  // CAP_DAC_OVERRIDE, temporary chmod/chown, or permission-changing crash windows.
  const retained = join(
    dirname(source),
    `.manager-quarantine-${id}-${basename(name)}`,
  );
  const restore = join(
    dirname(source),
    `.manager-restore-${id}-${basename(name)}`,
  );
  const quarantined = join(base, 'quarantine', name);
  await mkdir(dirname(quarantined), { recursive: true, mode: 0o700 });
  const saved = await exists(join(backupRoot, name));
  if (!saved && !allowMissing) throw new Error('updateJournalInvalid');
  if (!(await exists(retained))) {
    if (saved && !(await exists(restore))) {
      const temporary = `${restore}.partial-${randomUUID()}`;
      await copyPersistentTree(join(backupRoot, name), temporary);
      await durableRename(temporary, restore);
    }
    if (await exists(source)) await durableRename(source, retained);
  }
  if ((await exists(retained)) && !(await exists(quarantined)))
    await symlink(relative(dirname(quarantined), retained), quarantined);
  if (saved && !(await exists(source))) await durableRename(restore, source);
}

export function specification(inspect, image, component) {
  const endpoints = Object.fromEntries(
    Object.entries(inspect.NetworkSettings.Networks).map(([name, endpoint]) => [
      name,
      {
        Aliases: (endpoint.Aliases ?? []).filter(
          (alias) => alias !== inspect.Id && alias !== inspect.Id.slice(0, 12),
        ),
        ...(endpoint.IPAMConfig ? { IPAMConfig: endpoint.IPAMConfig } : {}),
      },
    ]),
  );
  return {
    ...inspect.Config,
    Image: image,
    HostConfig:
      component?.id === 'browser'
        ? { ...inspect.HostConfig, Dns: [...component.dns] }
        : inspect.HostConfig,
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
}

export class TransactionalUpdater {
  constructor({
    manifest,
    docker,
    configuration,
    adoptionPath,
    directory,
    healthTimeoutMs = 240_000,
    pollMs = 2_000,
  }) {
    Object.assign(this, {
      manifest,
      docker,
      configuration,
      adoptionPath,
      directory,
      healthTimeoutMs,
      pollMs,
    });
    this.busy = false;
    this.current = null;
    this.backupSizeCache = new Map();
    this.backupSizeTask = Promise.resolve();
    this.measureBackupSize = allocatedTreeSize;
  }

  status() {
    const operation = this.current;
    if (!operation) return { busy: this.busy, operation: null };
    // Persisted specifications contain environment secrets; never return them.
    return {
      busy: this.busy,
      operation: {
        id: operation.id,
        status: operation.status,
        phase: operation.phase,
        startedAt: operation.startedAt,
        finishedAt: operation.finishedAt,
        error: operation.error,
        events: operation.events,
        images: operation.images,
        previousImages: operation.previousImages,
        backupRetained: operation.backupComplete === true,
        backupPolicy: recordedBackupPolicy(operation),
        rollbackAvailable:
          operation.checkpoint !== true &&
          operation.status === 'succeeded' &&
          (operation.backupComplete === true ||
            withoutDataBackup(recordedBackupPolicy(operation))),
        mode: operation.mode ?? 'standard',
        actor: operation.actor ?? null,
        builds: operation.builds ?? {},
        restoreSource: operation.restoreSource ?? null,
        checkpoint: operation.checkpoint === true,
      },
    };
  }

  async readOperation(id) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw Error('updateJournalInvalid');
    if (this.current?.id === id) return this.current;
    const path = join(this.directory, `${id}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw Error('updateJournalInvalid');
    const operation = JSON.parse(await readFile(path, 'utf8'));
    if (
      operation.id !== id ||
      operation.stack !== this.manifest.stack ||
      operation.environment !== this.manifest.environment
    )
      throw Error('updateJournalInvalid');
    recordedBackupPolicy(operation);
    return operation;
  }

  async history() {
    const names = await readdir(this.directory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const ids = new Set(
      names
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .map((name) => name.slice(0, -5)),
    );
    if (this.current) ids.add(this.current.id);
    const operations = [];
    for (const id of ids) {
      try {
        const op = await this.readOperation(id);
        // Explicit public projection. Never expose original/target container specs or Docker output.
        const builds = Object.fromEntries(
          Object.entries(op.builds ?? {})
            .filter(([id]) =>
              [
                'application',
                'browser',
                'ingress',
                'egress',
                'manager',
              ].includes(id),
            )
            .map(([id, value]) => [
              id,
              {
                from: value.from,
                to: value.to,
              },
            ]),
        );
        operations.push({
          id: op.id,
          status: op.status,
          phase: op.phase,
          startedAt: op.startedAt,
          finishedAt: op.finishedAt ?? null,
          actor: op.actor ?? null,
          builds,
          restoreSource: op.restoreSource ?? null,
          checkpoint: op.checkpoint === true,
          hostObservation: op.hostObservation === true,
          backupPolicy: recordedBackupPolicy(op),
          backupRetained: op.backupComplete === true,
          error: op.error ? this.safeError(new Error(op.error)) : null,
          events: (op.events ?? [])
            .slice(-50)
            .map((e) => ({ at: e.at, phase: e.phase, status: e.status })),
        });
      } catch {
        /* A malformed journal must not disclose private data or hide valid records. */
      }
    }
    return {
      operations: operations
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, 100),
    };
  }

  async observeManagerBuild(observation) {
    if (
      !observation?.build ||
      !/^sha256:[a-f0-9]{64}$/.test(observation.imageId ?? '')
    )
      return;
    if (this.observedManagerImage === observation.imageId) return;
    const path = join(this.directory, '..', 'manager-build-observation.json');
    let previous = null;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return;
      previous = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') return;
    }
    if (previous?.imageId === observation.imageId) {
      this.observedManagerImage = observation.imageId;
      return;
    }
    const now = new Date().toISOString();
    if (
      previous?.build &&
      /^sha256:[a-f0-9]{64}$/.test(previous.imageId ?? '')
    ) {
      const key = digest({
        before: previous.imageId,
        after: observation.imageId,
        baseline: previous.observedAt,
      }).slice(0, 32);
      const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicJson(join(this.directory, `${id}.json`), {
        id,
        stack: this.manifest.stack,
        environment: this.manifest.environment,
        hostObservation: true,
        status: 'succeeded',
        phase: 'complete',
        startedAt: now,
        finishedAt: now,
        actor: null,
        builds: { manager: { from: previous.build, to: observation.build } },
        backupPolicy: 'none-v1',
        backupComplete: false,
        events: [{ at: now, phase: 'complete', status: 'succeeded' }],
      });
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicJson(path, {
      imageId: observation.imageId,
      build: observation.build,
      observedAt: now,
    });
    this.observedManagerImage = observation.imageId;
  }

  async restorationSource(id) {
    const op = await this.readOperation(id);
    if (
      !op.backupComplete ||
      !terminal.has(op.status) ||
      withoutDataBackup(recordedBackupPolicy(op))
    )
      throw Error('updateRollbackUnavailable');
    for (const path of [
      join(this.directory, id),
      join(this.directory, id, 'backup'),
    ]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error('updateJournalInvalid');
    }
    const policy = recordedBackupPolicy(op);
    const entries = policy === MINIMAL ? op.backupScope : backupEntries(policy);
    if (policy === MINIMAL) {
      const application = op.containers.find(
        (c) => c.component === 'application',
      );
      if (
        !application ||
        digest(entries) !==
          digest([
            ...backupEntries(MINIMAL),
            ...minimalHomeEntries(application.original.Env),
          ]) ||
        !Array.isArray(op.backupMissing) ||
        op.backupMissing.some(
          (name) =>
            !minimalHomeEntries(application.original.Env)
              .slice(1)
              .includes(name),
        )
      )
        throw Error('updateJournalInvalid');
    }
    const archive = archiveDescriptor(op);
    if (archive) {
      const info = await lstat(
        join(this.directory, id, 'backup', BACKUP_ARCHIVE_NAME),
      );
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== archive.bytes
      )
        throw Error('updateBackupArchiveInvalid');
    }
    return { op, policy, entries, archive };
  }

  async planRestore(id) {
    const { op, policy, entries, archive } = await this.restorationSource(id);
    const images = Object.fromEntries(
      op.containers.map((item) => [item.component, item.original.Image]),
    );
    // Old configuration/secrets are never used as a replacement container specification.
    const plan = await this.plan(images, 'standard', 'full');
    if (policy === MINIMAL) {
      const application = plan.containers.find(
        (item) => item.component === 'application',
      );
      const inspect = application
        ? await this.docker.inspectContainer(application.id)
        : null;
      if (
        !inspect ||
        digest(entries) !==
          digest([
            ...backupEntries(MINIMAL),
            ...minimalHomeEntries(inspect.Config.Env),
          ])
      )
        throw Error('updateJournalInvalid');
    }
    return {
      ...plan,
      fingerprint: digest({
        plan: plan.fingerprint,
        id,
        archive,
        entries,
        policy,
      }),
      restoreSource: id,
      restorePolicy: policy,
      restoreScope: entries,
      confirmation: 'RESTORE_SAVED_STATE',
    };
  }

  async planCheckpoint(backupMode = 'full') {
    if (!['full', 'minimal'].includes(backupMode))
      throw Error('updateConfirmationRequired');
    const inventory = await collectInventory(this.manifest, this.docker);
    const application = inventory.components.find(
      (item) => item.id === 'application',
    );
    if (!application?.containerId) throw Error('updateBlocked');
    const inspect = await this.docker.inspectContainer(application.containerId);
    const plan = await this.plan(
      { application: inspect.Config.Image },
      'standard',
      backupMode,
    );
    return {
      ...plan,
      checkpoint: true,
      fingerprint: digest({ plan: plan.fingerprint, checkpoint: true }),
      confirmation: 'CREATE_BACKUP',
    };
  }

  async restoreHistoricalData(id) {
    const source = await this.restorationSource(id);
    const base = join(this.directory, this.current.id);
    const destination = join(base, 'historical-input');
    const roots = source.entries.filter(
      (name) => !source.op.backupMissing?.includes(name),
    );
    let backupRoot = join(this.directory, id, 'backup');
    if (source.archive) {
      await extractBackupArchive({
        path: join(backupRoot, BACKUP_ARCHIVE_NAME),
        destination,
        descriptor: source.archive,
        roots,
      });
      backupRoot = destination;
    }
    // Validate every entry before modifying any live data.
    for (const name of source.entries) {
      if (
        (await exists(join(backupRoot, name))) !==
        !source.op.backupMissing?.includes(name)
      )
        throw Error('updateJournalInvalid');
    }
    const storage = join(
      this.configuration.hostStatePath,
      'manager-state',
      'updates',
      this.current.id,
      'source-restore',
    );
    const [local, alias] = await Promise.all([
      lstat(base),
      lstat(dirname(storage)),
    ]);
    if (
      !alias.isDirectory() ||
      alias.isSymbolicLink() ||
      local.dev !== alias.dev ||
      local.ino !== alias.ino
    )
      throw Error('updateJournalInvalid');
    await mkdir(storage, { recursive: true, mode: 0o700 });
    for (const name of source.entries) {
      if (source.policy === MINIMAL)
        await this.restoreMinimalEntry(storage, name, backupRoot, {
          missing: source.op.backupMissing,
          restoreId: `${this.current.id}-source`,
        });
      else
        await restorePersistentEntry(
          this.configuration.hostStatePath,
          storage,
          `${this.current.id}-source`,
          name,
          { backupRoot },
        );
    }
    if (source.archive) await removeDiscardedBackupTree(destination);
  }

  async listBackups() {
    const entries = await readdir(this.directory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const backups = [];
    // Expose the Docker-host path only when the two mounts identify the same directory.
    const alias = join(
      this.configuration.hostStatePath,
      'manager-state',
      'updates',
    );
    const [localRoot, aliasRoot] = await Promise.all([
      lstat(this.directory).catch(() => null),
      lstat(alias).catch(() => null),
    ]);
    const hostDirectory =
      localRoot?.isDirectory() &&
      aliasRoot?.isDirectory() &&
      !aliasRoot.isSymbolicLink() &&
      localRoot.dev === aliasRoot.dev &&
      localRoot.ino === aliasRoot.ino
        ? join(this.configuration.stateRoot, 'manager-state', 'updates')
        : null;
    for (const id of entries.filter((name) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        name,
      ),
    )) {
      const directory = join(this.directory, id);
      const stat = await lstat(directory).catch(() => null);
      const backup = await lstat(join(directory, 'backup')).catch(() => null);
      if (
        !stat?.isDirectory() ||
        stat.isSymbolicLink() ||
        !backup?.isDirectory() ||
        backup.isSymbolicLink()
      )
        continue;
      let operation = this.current?.id === id ? this.current : null;
      if (!operation) {
        const journal = join(this.directory, `${id}.json`);
        const metadata = await lstat(journal).catch(() => null);
        if (metadata?.isFile() && !metadata.isSymbolicLink()) {
          try {
            operation = JSON.parse(await readFile(journal, 'utf8'));
          } catch {
            /* Fail closed for incomplete metadata. */
          }
        }
      }
      let policy = null;
      let archive = null;
      try {
        if (operation) {
          archive = archiveDescriptor(operation);
          policy = recordedBackupPolicy(operation);
        }
      } catch {
        /* Unknown policies stay protected. */
      }
      const valid =
        operation?.id === id &&
        operation.stack === this.manifest.stack &&
        operation.environment === this.manifest.environment &&
        policy !== null;
      const blocked =
        this.busy || (this.current && !terminal.has(this.current.status));
      const measurable = valid && terminal.has(operation.status) && !blocked;
      const archivePath = join(directory, 'backup', BACKUP_ARCHIVE_NAME);
      const compressed = archive
        ? await lstat(archivePath).catch(() => null)
        : null;
      const archivePresent =
        compressed?.isFile() &&
        !compressed.isSymbolicLink() &&
        compressed.nlink === 1 &&
        compressed.size === archive.bytes;
      const measured = measurable
        ? archive
          ? archivePresent
            ? { bytes: compressed.size, status: 'ready' }
            : null
          : this.backupSize(id, join(directory, 'backup'), backup)
        : null;
      const sizeBytes = measured?.bytes ?? null;
      backups.push({
        id,
        build: valid ? (operation.builds?.application?.from ?? null) : null,
        backupPolicy: valid ? policy : null,
        path: hostDirectory
          ? join(
              hostDirectory,
              id,
              'backup',
              ...(archive ? [BACKUP_ARCHIVE_NAME] : []),
            )
          : null,
        managerPath: archive ? archivePath : join(directory, 'backup'),
        format: archive ? BACKUP_ARCHIVE_FORMAT : 'directory',
        sizeBytes,
        sizeStatus: measured?.status ?? 'unavailable',
        createdAt:
          valid && Number.isFinite(Date.parse(operation.startedAt))
            ? operation.startedAt
            : backup.mtime.toISOString(),
        status:
          valid && typeof operation.status === 'string'
            ? operation.status
            : 'unknown',
        current: this.current?.id === id,
        restorable:
          valid &&
          operation.backupComplete === true &&
          (!archive || archivePresent),
        canDelete: Boolean(!blocked && valid && terminal.has(operation.status)),
        protectionReason: blocked
          ? 'managerBackupOperationProtected'
          : !valid || !terminal.has(operation.status)
            ? 'managerBackupMetadataProtected'
            : null,
      });
    }
    return {
      sizesCalculating: backups.some(
        (backup) => backup.sizeStatus === 'calculating',
      ),
      totalSizeBytes: backups.every((backup) => backup.sizeBytes !== null)
        ? backups.reduce((total, backup) => total + backup.sizeBytes, 0)
        : null,
      backups: backups.sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      ),
    };
  }

  backupSize(id, path, value) {
    const identity = backupIdentity(value);
    const cached = this.backupSizeCache.get(id);
    if (
      cached?.identity === identity &&
      (cached.status !== 'unavailable' || cached.retryAt > Date.now())
    )
      return cached;
    const entry = { identity, bytes: null, status: 'calculating' };
    this.backupSizeCache.set(id, entry);
    // A single background queue survives list requests. A large backup must
    // finish rather than restart after each HTTP deadline and starve the rest.
    this.backupSizeTask = this.backupSizeTask.then(async () => {
      const check = () => {
        if (
          this.busy ||
          (this.current && !terminal.has(this.current.status)) ||
          this.backupSizeCache.get(id) !== entry
        )
          throw new Error('backupSizeDeferred');
      };
      try {
        check();
        const before = await lstat(path);
        if (
          !before.isDirectory() ||
          before.isSymbolicLink() ||
          backupIdentity(before) !== identity
        )
          throw new Error('backupChanged');
        const expected = {
          stack: this.manifest.stack,
          environment: this.manifest.environment,
          id,
          identity,
        };
        const cachePath = join(dirname(path), 'backup-size.json');
        const saved = await readBackupSize(cachePath, expected).catch(
          () => null,
        );
        check();
        const bytes = saved ?? (await this.measureBackupSize(path, { check }));
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error('backupSizeInvalid');
        const after = await lstat(path);
        if (
          backupIdentity(after) !== identity ||
          this.backupSizeCache.get(id) !== entry
        )
          throw new Error('backupChanged');
        check();
        if (saved === null) {
          // A cache write failure must not invalidate a measured size or a
          // backup. Never rewrite the transaction journal for this statistic.
          await atomicJson(cachePath, { schema: 1, ...expected, bytes }).catch(
            () => {},
          );
          check();
        }
        entry.bytes = bytes;
        entry.status = 'ready';
      } catch (error) {
        entry.status = 'unavailable';
        entry.retryAt =
          error.message === 'backupSizeDeferred' ? 0 : Date.now() + 60_000;
      }
    });
    return entry;
  }

  async deleteBackup({ operationId, confirmation }) {
    if (this.busy || (this.current && !terminal.has(this.current.status)))
      throw new Error('managerOperationInProgress');
    if (confirmation !== 'DELETE_UPDATE_BACKUP')
      throw new Error('managerBackupConfirmationRequired');
    if (
      typeof operationId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        operationId,
      )
    )
      throw new Error('managerBackupInvalid');
    this.busy = true;
    try {
      return await this.#discardBackup(operationId);
    } finally {
      this.busy = false;
    }
  }

  async #discardBackup(operationId) {
    const directory = join(this.directory, operationId);
    const stat = await lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error('managerBackupInvalid');
    const current = this.current?.id === operationId;
    const metadataPath = join(
      this.directory,
      current ? 'transaction.json' : `${operationId}.json`,
    );
    const metadata = await lstat(metadataPath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink())
      throw new Error('managerBackupInvalid');
    const operation = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (
      operation.id !== operationId ||
      operation.stack !== this.manifest.stack ||
      operation.environment !== this.manifest.environment ||
      !terminal.has(operation.status)
    )
      throw new Error('managerBackupInvalid');
    const path = join(directory, 'backup');
    recordedBackupPolicy(operation);
    archiveDescriptor(operation);
    const backup = await lstat(path).catch(() => null);
    if (backup && (!backup.isDirectory() || backup.isSymbolicLink()))
      throw new Error('managerBackupInvalid');
    // Invalidate rollback durably before deleting data, including if deletion is interrupted.
    operation.backupComplete = false;
    operation.backupDeletedAt = new Date().toISOString();
    await atomicJson(metadataPath, operation);
    if (current) this.current = operation;
    this.backupSizeCache.delete(operationId);
    // Only the backup subtree: preserve transaction metadata and quarantine data.
    if (backup) await removeDiscardedBackupTree(path);
    return { ok: true };
  }

  async backupRetention() {
    let policy;
    try {
      const path = join(this.directory, '..', 'backup-retention.json');
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('managerBackupRetentionInvalid');
      policy = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { maxBackups: 10 };
      throw error;
    }
    if (
      policy.stack !== this.manifest.stack ||
      policy.environment !== this.manifest.environment ||
      !Number.isInteger(policy.maxBackups) ||
      policy.maxBackups < 1 ||
      policy.maxBackups > 1000
    )
      throw new Error('managerBackupRetentionInvalid');
    return { maxBackups: policy.maxBackups };
  }

  async setBackupRetention({ maxBackups }) {
    if (this.busy || (this.current && !terminal.has(this.current.status)))
      throw new Error('managerOperationInProgress');
    if (!Number.isInteger(maxBackups) || maxBackups < 1 || maxBackups > 1000)
      throw new Error('managerBackupRetentionInvalid');
    this.busy = true;
    try {
      await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
      await atomicJson(join(this.directory, '..', 'backup-retention.json'), {
        stack: this.manifest.stack,
        environment: this.manifest.environment,
        maxBackups,
      });
      return { maxBackups };
    } finally {
      this.busy = false;
    }
  }

  async #enforceBackupRetention() {
    // Called under the update lock, only after a successful durable commit.
    const { maxBackups } = await this.backupRetention();
    const { backups } = await this.listBackups();
    for (const backup of backups.slice(maxBackups)) {
      if (backup.current || !terminal.has(backup.status)) continue;
      await this.#discardBackup(backup.id);
    }
  }

  async save(phase, status = this.current.status) {
    this.current.phase = phase;
    this.current.status = status;
    this.current.events.push({ at: new Date().toISOString(), phase, status });
    await atomicJson(join(this.directory, 'transaction.json'), this.current);
  }

  async plan(images, mode = 'standard', backupMode) {
    if (mode !== 'standard') throw new Error('updateInvalidMode');
    const backupPolicy = environmentBackupPolicy(this.manifest, backupMode);
    if (
      !images ||
      Object.keys(images).length === 0 ||
      Object.keys(images).some(
        (id) => !this.manifest.components.some((c) => c.id === id),
      )
    )
      throw new Error('updateInvalidImages');
    for (const [id, image] of Object.entries(images)) {
      const component = this.manifest.components.find((c) => c.id === id);
      if (
        typeof image !== 'string' ||
        !component.allowedImageRepositories.includes(repository(image)) ||
        !/(:[^/:]+|@sha256:[a-f0-9]{64})$/.test(image)
      )
        throw new Error('updateImageNotAllowed');
    }
    const inventory = await collectInventory(this.manifest, this.docker);
    const adoption = evaluateAdoption(
      inventory,
      await readAdoptionRecord(this.adoptionPath),
    );
    const blockers = [...adoption.adoption.blockers];
    if (adoption.adoption.state === 'drifted')
      blockers.push('updateAdoptionDrift');
    const containers = [];
    for (const component of inventory.components) {
      if (
        component.adoption !== 'managed' &&
        adoption.adoption.state !== 'adopted'
      )
        blockers.push(`${component.id}:updateNotManaged`);
      if (component.state !== 'healthy')
        blockers.push(`${component.id}:updateNotHealthy`);
      if (!component.containerId) continue;
      const inspect = await this.docker.inspectContainer(component.containerId);
      if (
        component.id === 'browser' &&
        !/^BROWSER_WS_PATH=[A-Za-z0-9_-]{32,128}$/.test(
          inspect.Config?.Env?.find((entry) =>
            entry.startsWith('BROWSER_WS_PATH='),
          ) ?? '',
        )
      )
        blockers.push('browser:updateBrowserConfigurationInvalid');
      if (
        component.id === 'browser' &&
        (inspect.HostConfig?.Privileged ||
          inspect.Config?.User !== 'pwuser' ||
          !inspect.HostConfig?.ReadonlyRootfs ||
          !inspect.HostConfig?.CapDrop?.includes('ALL') ||
          inspect.HostConfig?.CapAdd?.length ||
          Object.keys(inspect.HostConfig?.PortBindings ?? {}).length ||
          inspect.Mounts?.length ||
          !inspect.HostConfig?.SecurityOpt?.includes(
            'no-new-privileges:true',
          ) ||
          !inspect.HostConfig?.SecurityOpt?.some(
            (option) =>
              option.startsWith('seccomp=') && !option.includes('unconfined'),
          ))
      )
        blockers.push('browser:updateIsolationRequired');
      if (component.id === 'browser') {
        const required = this.manifest.components.find(
          (item) => item.id === 'browser',
        ).requiredNetworks;
        try {
          const networks = await Promise.all(
            required.map((name) => this.docker.inspectNetwork(name)),
          );
          if (
            JSON.stringify(
              Object.keys(inspect.NetworkSettings?.Networks ?? {}).sort(),
            ) !== JSON.stringify([...required].sort()) ||
            networks.some(
              (network, index) =>
                network.Name !== required[index] ||
                network.Driver !== 'bridge' ||
                network.Internal !==
                  required[index].endsWith('-browser-control'),
            )
          )
            blockers.push('browser:updateIsolationRequired');
        } catch {
          // Missing/unverifiable networks must fail closed, not imply isolation.
          blockers.push('browser:updateIsolationRequired');
        }
      }
      if (
        inspect.Name !==
        `/${this.manifest.components.find((c) => c.id === component.id).canonicalName}`
      )
        blockers.push(`${component.id}:updateCanonicalNameRequired`);
      if (
        !inspect.Config.Healthcheck ||
        inspect.Config.Healthcheck.Test?.[0] === 'NONE'
      )
        blockers.push(`${component.id}:updateHealthcheckRequired`);
      // Every mount must remain intact; business data outside STATE_ROOT is never rolled back.
      if ((inspect.Mounts ?? []).some((m) => m.Type !== 'bind'))
        blockers.push(`${component.id}:updateUnsupportedMount`);
      for (const mount of inspect.Mounts ?? []) {
        const root = this.configuration.stateRoot;
        if (
          !(
            dataEntries.some(
              (name) =>
                mount.Source === `${root}/${name}` ||
                mount.Source.startsWith(`${root}/${name}/`),
            ) ||
            (mount.Source === `${root}/manager-run` &&
              mount.Destination === '/run/mergeron-manager') ||
            (mount.Destination === '/appdata' &&
              mount.Source === this.configuration.appdataRoot)
          )
        )
          blockers.push(`${component.id}:updateMountOutsideState`);
        const required = { '/home/codex': 'home', '/workspaces': 'workspace' }[
          mount.Destination
        ];
        if (required && mount.Source !== `${root}/${required}`)
          blockers.push(`${component.id}:updateMountSourceMismatch`);
      }
      containers.push({
        component: component.id,
        id: inspect.Id,
        imageId: inspect.Image,
        name: inspect.Name.slice(1),
        fingerprint: digest({
          config: inspect.Config,
          host: inspect.HostConfig,
          mounts: [...(inspect.Mounts ?? [])].sort((a, b) =>
            a.Destination.localeCompare(b.Destination),
          ),
          networks: Object.keys(inspect.NetworkSettings.Networks).sort(),
        }),
      });
    }
    for (const name of dataEntries) {
      const path = join(this.configuration.hostStatePath, name);
      if (!(await exists(path)) || (await lstat(path)).isSymbolicLink())
        blockers.push(`persistent:${name}:updateUnsafePath`);
    }
    let backupScope = backupEntries(backupPolicy);
    if (backupPolicy === MINIMAL) {
      const application = containers.find(
        (item) => item.component === 'application',
      );
      if (!application) throw new Error('updateBlocked');
      const inspect = await this.docker.inspectContainer(application.id);
      const homeEntries = minimalHomeEntries(inspect.Config.Env);
      backupScope = [...backupScope, ...homeEntries];
      // Refuse ancestor links: lstat of just a leaf would still follow its parents.
      for (const name of backupScope) {
        const parts = name.split('/');
        for (let index = 1; index <= parts.length; index++) {
          const path = join(
            this.configuration.hostStatePath,
            ...parts.slice(0, index),
          );
          if (!(await exists(path))) break;
          if ((await lstat(path)).isSymbolicLink())
            blockers.push('updateUnsafePath');
        }
      }
      const database = join(this.configuration.hostStatePath, homeEntries[0]);
      if (!(await exists(database)) || !(await lstat(database)).isFile())
        blockers.push('updateMinimalDatabaseMissing');
    }
    const stable = {
      stack: this.manifest.stack,
      environment: this.manifest.environment,
      mode,
      backupPolicy,
      ...(backupMode !== undefined ? { backupMode } : {}),
      backupScope,
      backupFormat: withoutDataBackup(backupPolicy)
        ? null
        : BACKUP_ARCHIVE_FORMAT,
      images,
      containers,
      cliProtection: cliProtectionFingerprint(this.configuration),
      blockers: [...new Set(blockers)].sort(),
    };
    return {
      ...stable,
      fingerprint: digest(stable),
      applicable: !stable.blockers.length && !this.busy,
      excludedFromDataRollback: withoutDataBackup(backupPolicy)
        ? ['all-data']
        : backupPolicy === MINIMAL
          ? [
              '/appdata',
              'workspace',
              'conversations-on-disk',
              'logs',
              'other-home-files',
            ]
          : backupPolicy === LEGACY_FULL || backupPolicy === 'full-v1'
            ? ['/appdata']
            : ['/appdata', 'logs', 'regenerable-caches-and-dependencies'],
      confirmation: updateConfirmation(backupPolicy),
      busy: this.busy,
    };
  }

  async begin({
    images,
    confirmation,
    expectedFingerprint,
    mode = 'standard',
    backupMode,
    actor,
    restoreSource,
    checkpoint,
  }) {
    if (this.busy) throw new Error('managerOperationInProgress');
    if (
      confirmation !==
      (checkpoint
        ? 'CREATE_BACKUP'
        : restoreSource
          ? 'RESTORE_SAVED_STATE'
          : updateConfirmation(
              environmentBackupPolicy(this.manifest, backupMode),
            ))
    )
      throw new Error('updateConfirmationRequired');
    this.busy = true;
    try {
      const plan = checkpoint
        ? await this.planCheckpoint(backupMode)
        : restoreSource
          ? await this.planRestore(restoreSource)
          : await this.plan(images, mode, backupMode);
      if (plan.fingerprint !== expectedFingerprint)
        throw new Error('updatePlanChanged');
      if (plan.blockers.length) throw new Error('updateBlocked');
      // Only one durable operation can exist. A failed recovery blocks all new writes.
      if (this.current && !terminal.has(this.current.status))
        throw new Error('updateRecoveryRequired');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (this.current)
        await atomicJson(
          join(this.directory, `${this.current.id}.json`),
          this.current,
        );
      this.current = {
        id: randomUUID(),
        stack: this.manifest.stack,
        environment: this.manifest.environment,
        status: 'running',
        phase: 'preparing',
        startedAt: new Date().toISOString(),
        mode,
        actor:
          actor && typeof actor.id === 'string' && actor.id.length <= 128
            ? {
                id: actor.id,
                name:
                  typeof actor.name === 'string'
                    ? actor.name.slice(0, 160)
                    : null,
              }
            : null,
        restoreSource: restoreSource ?? null,
        checkpoint: checkpoint === true,
        backupPolicy: plan.backupPolicy,
        backupScope: plan.backupScope,
        backupMissing: [],
        images: plan.images,
        previousImages: {},
        containers: [],
        events: [],
        backupComplete: false,
        restored: [],
      };
      await this.save('preparing');
      this.task = this.run(plan).finally(() => {
        this.busy = false;
      });
      return this.status();
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  async run(plan) {
    try {
      // Pull every requested image before stopping anything, then pin its immutable ID.
      const imageIds = {};
      const targetImages = {};
      for (const [component, reference] of Object.entries(
        plan.checkpoint ? {} : plan.images,
      )) {
        await this.docker.pullImage(reference);
        targetImages[component] = await this.docker.inspectImage(reference);
        imageIds[component] = pinnedImage(targetImages[component], reference);
      }
      const rechecked = plan.checkpoint
        ? await this.planCheckpoint(plan.backupMode)
        : plan.restoreSource
          ? await this.planRestore(plan.restoreSource)
          : await this.plan(plan.images, plan.mode, plan.backupMode);
      if (rechecked.fingerprint !== plan.fingerprint)
        throw new Error('updatePlanChanged');
      if (targetImages.application)
        assertCliPolicyImage(this.configuration, targetImages.application);
      const browserItem = plan.containers.find(
        (item) => item.component === 'browser',
      );
      const browserInspect = browserItem
        ? await this.docker.inspectContainer(browserItem.id)
        : null;
      for (const item of plan.containers) {
        const inspect = await this.docker.inspectContainer(item.id);
        this.current.previousImages[item.component] = inspect.Config.Image;
        const component = this.manifest.components.find(
          (c) => c.id === item.component,
        );
        const previousImage = await this.docker.inspectImage(inspect.Image);
        this.current.builds ??= {};
        this.current.builds[item.component] = {
          from:
            (await inspectInstalledBuild(
              this.docker,
              inspect,
              item.component,
            )) ?? installedImageBuild(previousImage, item.component),
          to: installedImageBuild(
            targetImages[item.component] ?? previousImage,
            item.component,
          ),
        };
        // A pre-existing DEV browser can be a local build. Its immutable image
        // ID is retained; never turn a local tag into an implicit registry pull.
        const previous =
          component.id === 'browser' &&
          /^sha256:[a-f0-9]{64}$/.test(previousImage.Id ?? '') &&
          previousImage.Id === inspect.Image &&
          !previousImage.RepoDigests?.length
            ? previousImage.Id
            : pinnedImage(previousImage, inspect.Config.Image);
        const target = specification(
          inspect,
          imageIds[item.component] ?? previous,
          component,
        );
        target.HostConfig = agentVisualSandbox(target.HostConfig, {
          environment: this.manifest.environment,
          component: component.id,
          labels: (targetImages[item.component] ?? previousImage).Config
            ?.Labels,
        });
        if (component.id === 'application' && browserInspect) {
          const browserComponent = this.manifest.components.find(
            (c) => c.id === 'browser',
          );
          const controlPath = browserInspect.Config.Env.find((entry) =>
            entry.startsWith('BROWSER_WS_PATH='),
          ).slice('BROWSER_WS_PATH='.length);
          // The secret is only persisted in the private transaction journal,
          // never in a status response, plan or diagnostic.
          target.Env = (target.Env ?? []).filter(
            (entry) => !entry.startsWith('MERGERON_BROWSER_ENDPOINT='),
          );
          target.Env.push(
            `MERGERON_BROWSER_ENDPOINT=ws://${browserComponent.canonicalName}:3000/${controlPath}`,
          );
          target.NetworkingConfig.EndpointsConfig[
            `${this.manifest.stack}-browser-control`
          ] ??= { Aliases: [component.canonicalName] };
        }
        target.Labels = {
          ...target.Labels,
          'io.mergeron.transaction': this.current.id,
        };
        this.current.containers.push({
          ...item,
          original: specification(inspect, previous, component),
          target,
          backupName: `${item.name}-rollback-${this.current.id}`,
        });
      }
      const entries = plan.backupScope;
      if (entries.length) {
        let bytes = 0;
        for (const name of entries)
          if (await exists(join(this.configuration.hostStatePath, name)))
            bytes += await treeSize(
              join(this.configuration.hostStatePath, name),
              { policy: plan.backupPolicy, path: name },
            );
        const space = await statfs(this.directory);
        if (space.bavail * space.bsize < bytes * 2.2 + 64 * 1024 ** 2)
          throw new Error('updateInsufficientBackupSpace');
      }
      await this.save('stopping');
      const stopped = await Promise.allSettled(
        this.stopOrder().map((item) => this.docker.stopContainer(item.id)),
      );
      const stopFailure = stopped.find(
        (result) => result.status === 'rejected',
      );
      if (stopFailure) throw stopFailure.reason;
      if (entries.length) {
        await this.save('backingUp');
        const backup = join(this.directory, this.current.id, 'backup');
        await mkdir(backup, { recursive: true, mode: 0o700 });
        const roots = [];
        for (const name of entries) {
          if (!(await exists(join(this.configuration.hostStatePath, name)))) {
            // Only optional minimal leaves may legitimately be absent.
            const optional =
              plan.backupPolicy === MINIMAL &&
              minimalHomeEntries(
                this.current.containers.find(
                  (item) => item.component === 'application',
                ).original.Env,
              )
                .slice(1)
                .includes(name);
            if (!optional) throw new Error('updateUnsafePath');
            this.current.backupMissing.push(name);
            continue;
          }
          roots.push(name);
        }
        const temporary = join(backup, `${BACKUP_ARCHIVE_NAME}.partial`);
        this.current.backupArchive = await createBackupArchive({
          root: this.configuration.hostStatePath,
          path: temporary,
          roots,
          policy: plan.backupPolicy,
        });
        await durableRename(temporary, join(backup, BACKUP_ARCHIVE_NAME));
        this.current.backupComplete = true;
      }
      if (plan.restoreSource) {
        await this.save('restoring');
        await this.restoreHistoricalData(plan.restoreSource);
      }
      if (plan.checkpoint) {
        await this.save('checkingHealth');
        await this.startAndCheck(this.current.containers);
        this.current.committed = true;
        await this.save('committing');
        await this.commit();
        return;
      }
      await this.save('replacing');
      for (const item of this.current.containers) {
        await this.docker.renameContainer(item.id, item.backupName);
        // Record intention before creating so recovery can resolve a crash after Docker accepted it.
        item.creating = true;
        await this.save('replacing');
        const created = await this.docker.createContainer(
          item.name,
          item.target,
        );
        item.candidateId = created.Id;
        await this.save('replacing');
      }
      await this.save('checkingHealth');
      await this.startAndCheck(
        this.current.containers.map((c) => ({ ...c, id: c.candidateId })),
      );
      // Commit point: after this durable record recovery finishes cleanup, never restores old data.
      this.current.committed = true;
      await this.save('committing');
      await this.commit();
    } catch (error) {
      console.error('Manager update failed', {
        code: error?.code,
        syscall: error?.syscall,
        reason: this.safeError(error),
      });
      this.current.error = this.safeError(error);
      try {
        if (this.current.checkpoint) await this.recoverCheckpoint();
        else await this.rollback();
      } catch (recoveryError) {
        this.current.error = this.safeError(recoveryError);
        await this.save('recoveryRequired', 'recoveryRequired');
      }
    }
  }

  safeError(error) {
    // Docker messages may contain environment or registry credentials.
    return /^update[A-Za-z]+$/.test(error?.message ?? '')
      ? error.message
      : 'updateDockerOrFilesystemFailure';
  }

  stopOrder() {
    return [...this.current.containers].sort(
      (a, b) =>
        ['ingress', 'application', 'browser', 'egress'].indexOf(a.component) -
        ['ingress', 'application', 'browser', 'egress'].indexOf(b.component),
    );
  }

  async startAndCheck(containers) {
    for (const component of ['egress', 'browser', 'application', 'ingress']) {
      const item = containers.find((c) => c.component === component);
      // Preparation may fail while only part of the original specifications
      // has been journalled. Those originals were not stopped; recover the
      // recorded subset without inventing missing container identities.
      if (!item) continue;
      const before = await this.docker.inspectContainer(item.id);
      if (!before.State.Running) await this.docker.startContainer(item.id);
      const deadline = Date.now() + this.healthTimeoutMs;
      while (true) {
        const inspect = await this.docker.inspectContainer(item.id);
        if (
          !inspect.State.Running ||
          inspect.State.Health?.Status === 'unhealthy'
        )
          throw new Error('updateHealthCheckFailed');
        if (inspect.State.Health?.Status === 'healthy') break;
        if (Date.now() >= deadline) throw new Error('updateHealthCheckTimeout');
        await sleep(this.pollMs);
      }
    }
    // Check all three again: a dependency must not have died during later startup.
    for (const item of containers) {
      const inspect = await this.docker.inspectContainer(item.id);
      if (!inspect.State.Running || inspect.State.Health?.Status !== 'healthy')
        throw new Error('updateHealthCheckFailed');
    }
  }

  async commit() {
    for (const item of this.current.containers.filter((item) =>
      ['ingress', 'egress'].includes(item.component),
    )) {
      try {
        const inspect = await this.docker.inspectContainer(
          this.current.checkpoint ? item.id : item.candidateId,
        );
        const build = await inspectInstalledBuild(
          this.docker,
          inspect,
          item.component,
        );
        if (build && this.current.builds?.[item.component])
          this.current.builds[item.component].to = build;
      } catch {
        /* Missing version metadata must not fail a healthy transaction. */
      }
    }
    for (const item of this.current.containers) {
      if (!this.current.checkpoint && (await this.containerExists(item.id)))
        await this.docker.removeContainer(item.id);
    }
    // Refresh the adoption baseline only for an already explicitly adopted stack.
    await this.refreshAdoption();
    this.current.finishedAt = new Date().toISOString();
    await this.save('complete', 'succeeded');
    // Cleanup failure must never turn a healthy committed update into a rollback.
    try {
      if (this.current.backupComplete) await this.#enforceBackupRetention();
    } catch {
      console.error(
        'Manager backup retention cleanup failed; backups retained',
      );
    }
  }

  async recoverCheckpoint() {
    // A checkpoint never replaced live data or containers. Do not restore a
    // snapshot over originals which may already be running after a crash.
    await this.startAndCheck(this.current.containers);
    this.current.finishedAt = new Date().toISOString();
    if (this.current.backupComplete) {
      this.current.committed = true;
      await this.commit();
    } else await this.save('complete', 'cancelled');
  }

  async refreshAdoption() {
    const adoption = await readAdoptionRecord(this.adoptionPath);
    if (adoption) {
      const inventory = await collectInventory(this.manifest, this.docker);
      await atomicJson(this.adoptionPath, {
        ...adoption,
        schemaVersion: 2,
        stack: inventory.stack,
        environment: inventory.environment,
        fingerprint: inventoryFingerprint(inventory),
        components: inventory.components,
      });
    }
  }

  async requestRollback({ confirmation, operationId }) {
    if (this.busy) throw new Error('managerOperationInProgress');
    const policy = this.current ? recordedBackupPolicy(this.current) : null;
    if (confirmation !== rollbackConfirmation(policy))
      throw new Error('updateConfirmationRequired');
    if (
      this.current?.id !== operationId ||
      this.current.status !== 'succeeded' ||
      this.current.checkpoint === true ||
      (!this.current.backupComplete && !withoutDataBackup(policy))
    )
      throw new Error('updateRollbackUnavailable');
    this.busy = true;
    try {
      // A drifted installation must never be silently replaced by a rollback.
      for (const item of this.current.containers) {
        const inspect = await this.docker.inspectContainer(item.candidateId);
        if (
          inspect.Config.Labels?.['io.mergeron.transaction'] !== operationId ||
          inspect.Name !== `/${item.name}` ||
          inspect.Config.Image !== item.target.Image
        )
          throw new Error('updateCandidateIdentityConflict');
        if (item.component === 'application')
          assertCliPolicyImage(
            this.configuration,
            await this.docker.inspectImage(item.original.Image),
          );
      }
      this.current.committed = false;
      this.current.status = 'running';
      this.current.finishedAt = undefined;
      await this.save('rollingBack');
      this.task = this.rollback()
        .catch(async (error) => {
          this.current.error = this.safeError(error);
          await this.save('recoveryRequired', 'recoveryRequired');
        })
        .finally(() => {
          this.busy = false;
        });
      return this.status();
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  async containerExists(id) {
    return (await this.docker.listContainers()).some((c) => c.Id === id);
  }

  validMinimalScope(entries) {
    const application = this.current.containers.find(
      (item) => item.component === 'application',
    );
    if (!application) return false;
    const home = minimalHomeEntries(application.original.Env);
    const missing = this.current.backupMissing;
    if (
      !Array.isArray(missing) ||
      new Set(missing).size !== missing.length ||
      missing.some((name) => !home.slice(1).includes(name))
    )
      return false;
    return digest(entries) === digest([...backupEntries(MINIMAL), ...home]);
  }

  async restoreMinimalEntry(
    storageBase,
    name,
    backupRoot = join(storageBase, 'backup'),
    { missing = this.current.backupMissing, restoreId = this.current.id } = {},
  ) {
    const parent = dirname(name);
    const allowMissing = missing?.includes(name) === true;
    const saved = await exists(join(backupRoot, name));
    if (!saved && !allowMissing) throw new Error('updateJournalInvalid');
    if (saved && allowMissing) throw new Error('updateJournalInvalid');
    if (
      !saved &&
      !(await exists(join(this.configuration.hostStatePath, name))) &&
      !this.current.restoreDirectoryMetadata?.[parent]
    )
      return;
    // The Manager has CHOWN + DAC_READ_SEARCH, not DAC_OVERRIDE/FOWNER.
    // Journal original parent metadata before temporarily making a private
    // directory writable. A crash retries using this same original metadata.
    const parts = parent === '.' ? [] : parent.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const info = await lstat(
        join(this.configuration.hostStatePath, ...parts.slice(0, index)),
      );
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('updateUnsafePath');
    }
    const directory = await open(
      join(this.configuration.hostStatePath, parent),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await directory.stat();
      this.current.restoreDirectoryMetadata ??= {};
      let original = this.current.restoreDirectoryMetadata[parent];
      if (!original) {
        original = {
          uid: info.uid,
          gid: info.gid,
          mode: info.mode & 0o7777,
          dev: info.dev,
          ino: info.ino,
        };
        this.current.restoreDirectoryMetadata[parent] = original;
        await this.save('rollingBack');
      }
      if (info.dev !== original.dev || info.ino !== original.ino)
        throw new Error('updateUnsafePath');
      try {
        await directory.chown(process.getuid(), process.getgid());
        await directory.chmod(original.mode | 0o700);
        await restorePersistentEntry(
          this.configuration.hostStatePath,
          storageBase,
          restoreId,
          name,
          { allowMissing, backupRoot },
        );
      } finally {
        await directory.chmod(original.mode);
        await directory.chown(original.uid, original.gid);
        await directory.sync();
      }
    } finally {
      await directory.close();
    }
  }

  async rollback() {
    if (this.current.committed) {
      await this.commit();
      return;
    }
    if (this.current.backupComplete) {
      for (const path of [
        join(this.directory, this.current.id),
        join(this.directory, this.current.id, 'backup'),
      ]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('updateJournalInvalid');
      }
    }
    const archive = archiveDescriptor(this.current);
    if (!archive || !this.current.backupComplete) return this.rollbackFrom();
    const policy = recordedBackupPolicy(this.current);
    const entries =
      policy === MINIMAL ? this.current.backupScope : backupEntries(policy);
    if (
      !Array.isArray(entries) ||
      (policy === MINIMAL && !this.validMinimalScope(entries))
    )
      throw new Error('updateJournalInvalid');
    const roots = entries.filter(
      (name) =>
        !(policy === MINIMAL && this.current.backupMissing.includes(name)),
    );
    const base = join(this.directory, this.current.id);
    const destination = join(base, 'restore-input');
    // A crashed extraction is never trusted/reused. Remove only this fixed,
    // private transaction subtree, not live data, archives or quarantine.
    if (await exists(destination)) await removeDiscardedBackupTree(destination);
    try {
      await extractBackupArchive({
        path: join(base, 'backup', BACKUP_ARCHIVE_NAME),
        destination,
        descriptor: archive,
        roots,
      });
      await this.rollbackFrom(destination);
    } finally {
      if (await exists(destination))
        await removeDiscardedBackupTree(destination);
    }
  }

  async rollbackFrom(
    backupRoot = join(this.directory, this.current.id, 'backup'),
  ) {
    const policy = recordedBackupPolicy(this.current);
    const entries = !this.current.backupComplete
      ? []
      : policy === MINIMAL
        ? this.current.backupScope
        : backupEntries(policy);
    if (
      !Array.isArray(entries) ||
      (policy === MINIMAL &&
        this.current.backupComplete &&
        !this.validMinimalScope(entries))
    )
      throw new Error('updateJournalInvalid');
    // A missing/corrupt saved entry is not the same as a file absent before
    // backup. Refuse it before stopping or removing any healthy candidate.
    for (const name of entries) {
      const saved = await exists(join(backupRoot, name));
      const expected = !(
        policy === MINIMAL && this.current.backupMissing.includes(name)
      );
      if (saved !== expected) throw new Error('updateJournalInvalid');
    }
    await this.save('rollingBack');
    for (const item of this.stopOrder()) {
      const all = await this.docker.listContainers();
      const candidate = item.candidateId
        ? all.find((c) => c.Id === item.candidateId)
        : item.creating
          ? all.find(
              (c) => c.Names?.includes(`/${item.name}`) && c.Id !== item.id,
            )
          : null;
      if (candidate) {
        const inspect = await this.docker.inspectContainer(candidate.Id);
        if (
          inspect.Config.Labels?.['io.mergeron.transaction'] !==
            this.current.id ||
          inspect.Config.Image !== item.target.Image
        )
          throw new Error('updateCandidateIdentityConflict');
        if (inspect.State.Running)
          await this.docker.stopContainer(candidate.Id);
        await this.docker.removeContainer(candidate.Id);
      }
    }
    if (this.current.backupComplete) {
      const base = join(this.directory, this.current.id);
      // manager-state is also mounted separately at /var/lib/... . Use its
      // STATE_ROOT alias for relative quarantine references to work both on
      // the Docker host and inside the Manager, not just in one namespace.
      const storageBase = join(
        this.configuration.hostStatePath,
        'manager-state',
        'updates',
        this.current.id,
      );
      const [journalDirectory, stateDirectory] = await Promise.all([
        lstat(base),
        lstat(storageBase),
      ]);
      if (
        journalDirectory.dev !== stateDirectory.dev ||
        journalDirectory.ino !== stateDirectory.ino
      )
        throw new Error('updateJournalInvalid');
      await mkdir(join(base, 'quarantine'), { recursive: true, mode: 0o700 });
      for (const name of entries) {
        // Even a previously restored minimal leaf may have a parent whose
        // ownership restoration was interrupted immediately before a crash.
        if (this.current.restored.includes(name) && policy !== MINIMAL)
          continue;
        if (policy === MINIMAL)
          await this.restoreMinimalEntry(storageBase, name, backupRoot);
        else
          await restorePersistentEntry(
            this.configuration.hostStatePath,
            storageBase,
            this.current.id,
            name,
            { backupRoot },
          );
        if (!this.current.restored.includes(name))
          this.current.restored.push(name);
        await this.save('rollingBack');
      }
    }
    for (const item of this.current.containers) {
      if (!(await this.containerExists(item.id))) {
        const all = await this.docker.listContainers();
        const existing = all.find((c) => c.Names?.includes(`/${item.name}`));
        if (existing && !item.creatingOriginal)
          throw new Error('updateOriginalIdentityConflict');
        item.creatingOriginal = true;
        await this.save('rollingBack');
        if (existing) item.id = existing.Id;
        else
          item.id = (
            await this.docker.createContainer(item.name, item.original)
          ).Id;
        await this.save('rollingBack');
      }
      const inspect = await this.docker.inspectContainer(item.id);
      if (
        inspect.Image !== item.imageId ||
        digest(inspect.Config.Labels) !== digest(item.original.Labels)
      )
        throw new Error('updateOriginalIdentityConflict');
      if (inspect.Name !== `/${item.name}`)
        await this.docker.renameContainer(item.id, item.name);
    }
    if (this.current.containers.length)
      await this.startAndCheck(this.current.containers);
    await this.refreshAdoption();
    this.current.finishedAt = new Date().toISOString();
    await this.save('complete', 'rolledBack');
  }

  async recover() {
    if (this.busy) throw new Error('managerOperationInProgress');
    this.busy = true;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, 'transaction.json');
      if (!(await exists(path))) return;
      this.current = JSON.parse(await readFile(path, 'utf8'));
      if (
        this.current.stack !== this.manifest.stack ||
        this.current.environment !== this.manifest.environment ||
        !/^[a-f0-9-]{36}$/.test(this.current.id)
      )
        throw new Error('updateJournalInvalid');
      recordedBackupPolicy(this.current);
      archiveDescriptor(this.current);
      if (terminal.has(this.current.status)) return;
      try {
        if (this.current.checkpoint) await this.recoverCheckpoint();
        else await this.rollback();
      } catch (error) {
        this.current.error = this.safeError(error);
        await this.save('recoveryRequired', 'recoveryRequired');
      }
    } finally {
      this.busy = false;
    }
  }
}
