import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  chmod,
  chown,
  lchown,
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
import { dirname, join, relative } from 'node:path';
import { collectInventory } from './inventory.mjs';
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
const dataEntries = [
  'home',
  'workspace',
  'logs',
  'ssh',
  'config',
  'backend-token.txt',
  'backend-token-nginx.txt',
  'openai-api-key.txt',
];
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
export async function copyPersistentTree(source, destination, concurrency = 1) {
  if (![1, 8].includes(concurrency))
    throw new Error('updateInvalidCopyConcurrency');
  const info = await lstat(source);
  if (info.isSocket()) return;
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    await lchown(destination, info.uid, info.gid);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    const entries = await readdir(source, { withFileTypes: true });
    if (concurrency === 1) {
      for (const { name } of entries)
        await copyPersistentTree(join(source, name), join(destination, name));
    } else {
      // Subdirectories stay sequential: the limit is global, not multiplied at
      // every recursion level. Symlinks are still handled with lstat/no-follow.
      const files = entries.filter((entry) => !entry.isDirectory());
      for (let index = 0; index < files.length; index += concurrency) {
        const results = await Promise.allSettled(
          files
            .slice(index, index + concurrency)
            .map(({ name }) =>
              copyPersistentTree(
                join(source, name),
                join(destination, name),
                concurrency,
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

async function treeSize(path) {
  const value = await lstat(path);
  if (value.isDirectory()) {
    let total = 0;
    for (const name of await readdir(path))
      total += await treeSize(join(path, name));
    return total;
  }
  return value.isFile() ? value.size : 0;
}

// Allocated disk space, like du: do not follow symlinks or count hardlinks twice.
async function allocatedTreeSize(path) {
  const pending = [path];
  const seen = new Set();
  let bytes = 0;
  // Bounded parallel metadata reads, not one syscall round-trip per file.
  // lstat deliberately never follows symlinks outside the backup.
  while (pending.length) {
    await Promise.all(
      pending.splice(-32).map(async (entry) => {
        const value = await lstat(entry);
        const inode = `${value.dev}:${value.ino}`;
        if (seen.has(inode)) return;
        seen.add(inode);
        bytes += value.blocks * 512;
        if (value.isDirectory()) {
          for (const name of await readdir(entry))
            pending.push(join(entry, name));
        }
      }),
    );
  }
  return bytes;
}

const backupIdentity = (value) =>
  `${value.dev}:${value.ino}:${value.mtimeMs}:${value.ctimeMs}`;

export async function restorePersistentEntry(stateRoot, base, id, name) {
  const source = join(stateRoot, name);
  // Linux requires write permission on a directory when changing its parent.
  // Same-parent renames keep UID-11002 private directories intact without
  // CAP_DAC_OVERRIDE, temporary chmod/chown, or permission-changing crash windows.
  const retained = join(stateRoot, `.manager-quarantine-${id}-${name}`);
  const restore = join(stateRoot, `.manager-restore-${id}-${name}`);
  const quarantined = join(base, 'quarantine', name);
  await mkdir(dirname(quarantined), { recursive: true, mode: 0o700 });
  if (!(await exists(retained))) {
    if (!(await exists(restore))) {
      const temporary = `${restore}.partial-${randomUUID()}`;
      await copyPersistentTree(join(base, 'backup', name), temporary);
      await durableRename(temporary, restore);
    }
    await durableRename(source, retained);
  }
  if (!(await exists(quarantined)))
    await symlink(relative(dirname(quarantined), retained), quarantined);
  if (!(await exists(source))) await durableRename(restore, source);
}

function specification(inspect, image) {
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
    HostConfig: inspect.HostConfig,
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
        mode: operation.mode ?? 'standard',
      },
    };
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
      const valid =
        operation?.id === id &&
        operation.stack === this.manifest.stack &&
        operation.environment === this.manifest.environment;
      const blocked =
        this.busy || (this.current && !terminal.has(this.current.status));
      const measurable = valid && terminal.has(operation.status) && !blocked;
      const measured = measurable
        ? this.backupSize(id, join(directory, 'backup'), backup)
        : null;
      const sizeBytes = measured?.bytes ?? null;
      backups.push({
        id,
        path: hostDirectory ? join(hostDirectory, id, 'backup') : null,
        managerPath: join(directory, 'backup'),
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
        restorable: valid && operation.backupComplete === true,
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
      try {
        const before = await lstat(path);
        if (
          !before.isDirectory() ||
          before.isSymbolicLink() ||
          backupIdentity(before) !== identity
        )
          throw new Error('backupChanged');
        const bytes = await this.measureBackupSize(path);
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error('backupSizeInvalid');
        const after = await lstat(path);
        if (
          backupIdentity(after) !== identity ||
          this.backupSizeCache.get(id) !== entry
        )
          throw new Error('backupChanged');
        entry.bytes = bytes;
        entry.status = 'ready';
      } catch {
        entry.status = 'unavailable';
        entry.retryAt = Date.now() + 60_000;
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

  async plan(images, mode = 'standard') {
    if (!['standard', 'dev-fast'].includes(mode))
      throw new Error('updateInvalidMode');
    if (
      mode === 'dev-fast' &&
      (this.manifest.environment !== 'development' ||
        this.manifest.stack === 'mergeron')
    )
      throw new Error('updateFastDevelopmentOnly');
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
    const stable = {
      stack: this.manifest.stack,
      environment: this.manifest.environment,
      mode,
      images,
      containers,
      blockers: [...new Set(blockers)].sort(),
    };
    return {
      ...stable,
      fingerprint: digest(stable),
      applicable: !stable.blockers.length && !this.busy,
      backupScope: dataEntries,
      excludedFromDataRollback: ['/appdata'],
      busy: this.busy,
    };
  }

  async begin({
    images,
    confirmation,
    expectedFingerprint,
    mode = 'standard',
  }) {
    if (this.busy) throw new Error('managerOperationInProgress');
    if (confirmation !== 'UPDATE_WITH_ROLLBACK')
      throw new Error('updateConfirmationRequired');
    this.busy = true;
    try {
      const plan = await this.plan(images, mode);
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
        images,
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
      for (const [component, reference] of Object.entries(plan.images)) {
        let cached;
        if (plan.mode === 'dev-fast' && reference.includes('@sha256:')) {
          try {
            const local = await this.docker.inspectImage(reference);
            if (pinnedImage(local, reference) === reference) cached = local;
          } catch {
            /* Missing or unverifiable image: pull normally. */
          }
        }
        if (!cached) await this.docker.pullImage(reference);
        imageIds[component] = pinnedImage(
          cached ?? (await this.docker.inspectImage(reference)),
          reference,
        );
      }
      const rechecked = await this.plan(plan.images, plan.mode);
      if (rechecked.fingerprint !== plan.fingerprint)
        throw new Error('updatePlanChanged');
      for (const item of plan.containers) {
        const inspect = await this.docker.inspectContainer(item.id);
        this.current.previousImages[item.component] = inspect.Config.Image;
        const previous = pinnedImage(
          await this.docker.inspectImage(inspect.Image),
          inspect.Config.Image,
        );
        const target = specification(
          inspect,
          imageIds[item.component] ?? previous,
        );
        target.Labels = {
          ...target.Labels,
          'io.mergeron.transaction': this.current.id,
        };
        this.current.containers.push({
          ...item,
          original: specification(inspect, previous),
          target,
          backupName: `${item.name}-rollback-${this.current.id}`,
        });
      }
      let bytes = 0;
      for (const name of dataEntries)
        bytes += await treeSize(join(this.configuration.hostStatePath, name));
      const space = await statfs(this.directory);
      if (space.bavail * space.bsize < bytes * 2.2 + 64 * 1024 ** 2)
        throw new Error('updateInsufficientBackupSpace');
      await this.save('stopping');
      const stopped = await Promise.allSettled(
        this.stopOrder().map((item) => this.docker.stopContainer(item.id)),
      );
      const stopFailure = stopped.find(
        (result) => result.status === 'rejected',
      );
      if (stopFailure) throw stopFailure.reason;
      await this.save('backingUp');
      const backup = join(this.directory, this.current.id, 'backup');
      await mkdir(backup, { recursive: true, mode: 0o700 });
      for (const name of dataEntries)
        await copyPersistentTree(
          join(this.configuration.hostStatePath, name),
          join(backup, name),
          plan.mode === 'dev-fast' ? 8 : 1,
        );
      this.current.backupComplete = true;
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
        await this.rollback();
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
        ['ingress', 'application', 'egress'].indexOf(a.component) -
        ['ingress', 'application', 'egress'].indexOf(b.component),
    );
  }

  async startAndCheck(containers) {
    for (const component of ['egress', 'application', 'ingress']) {
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
    for (const item of this.current.containers) {
      if (await this.containerExists(item.id))
        await this.docker.removeContainer(item.id);
    }
    // Refresh the adoption baseline only for an already explicitly adopted stack.
    await this.refreshAdoption();
    this.current.finishedAt = new Date().toISOString();
    await this.save('complete', 'succeeded');
    // Cleanup failure must never turn a healthy committed update into a rollback.
    try {
      await this.#enforceBackupRetention();
    } catch {
      console.error(
        'Manager backup retention cleanup failed; backups retained',
      );
    }
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
    if (confirmation !== 'ROLLBACK_WITH_DATA_RESTORE')
      throw new Error('updateConfirmationRequired');
    if (
      this.current?.id !== operationId ||
      this.current.status !== 'succeeded' ||
      !this.current.backupComplete
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

  async rollback() {
    if (this.current.committed) {
      await this.commit();
      return;
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
      for (const name of dataEntries) {
        if (this.current.restored.includes(name)) continue;
        await restorePersistentEntry(
          this.configuration.hostStatePath,
          storageBase,
          this.current.id,
          name,
        );
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
      if (terminal.has(this.current.status)) return;
      try {
        await this.rollback();
      } catch (error) {
        this.current.error = this.safeError(error);
        await this.save('recoveryRequired', 'recoveryRequired');
      }
    } finally {
      this.busy = false;
    }
  }
}
