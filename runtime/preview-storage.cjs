/** Fixed, bounded ephemeral storage. tmpfs usage also counts against runtime RAM. */
const previewStorage = Object.freeze({
  backend: 'tmpfs',
  memoryCharged: true,
  workspaceMb: 2048,
  cacheMb: 1024,
  temporaryMb: 256,
  dataMb: 128,
  inodesPerVolume: 262144,
});

const storageMounts = Object.freeze([
  { role: 'workspace', path: '/workspace', observerPath: '/target' },
  { role: 'cache', path: '/cache', observerPath: '/cache' },
  { role: 'temporary', path: '/tmp', observerPath: '/temporary' },
  { role: 'data', path: '/data', observerPath: '/data' },
]);

const cacheEnvironment = Object.freeze({
  HOME: '/cache/home',
  XDG_CACHE_HOME: '/cache/xdg',
  XDG_DATA_HOME: '/cache/data',
  COREPACK_HOME: '/cache/corepack',
  PNPM_HOME: '/cache/pnpm',
  npm_config_cache: '/cache/npm',
  npm_config_store_dir: '/cache/pnpm-store',
  pnpm_config_store_dir: '/cache/pnpm-store',
  npm_config_devdir: '/cache/node-gyp',
  TMPDIR: '/tmp',
});

function storageSample(stat) {
  const totalBytes = Number(stat.blocks) * Number(stat.bsize),
    availableBytes = Number(stat.bavail) * Number(stat.bsize),
    // Filesystems such as btrfs report 0/0: that is not inode exhaustion.
    totalInodes = Number(stat.files) > 0 ? Number(stat.files) : null,
    availableInodes = totalInodes === null ? null : Number(stat.ffree);
  return {
    totalBytes,
    availableBytes,
    totalInodes,
    availableInodes,
    cause:
      availableInodes === 0
        ? 'inodes_exhausted'
        : availableBytes === 0
          ? 'space_exhausted'
          : null,
  };
}

/** Only accept numeric, allowlisted output from our immutable mount keeper. */
function readStorageObservation(text) {
  for (const line of text.trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line);
      if (
        v.version !== 1 ||
        !Number.isSafeInteger(v.checkedAt) ||
        v.checkedAt < 0 ||
        v.checkedAt > Date.now() + 60000 ||
        !Array.isArray(v.mounts) ||
        v.mounts.length !== storageMounts.length
      )
        continue;
      const mounts = storageMounts.map((m, i) => {
        const s = v.mounts[i];
        if (s.role !== m.role) throw Error('invalid');
        for (const k of [
          'totalBytes',
          'availableBytes',
          'totalInodes',
          'availableInodes',
        ]) {
          if (s[k] !== null && (!Number.isSafeInteger(s[k]) || s[k] < 0))
            throw Error('invalid');
        }
        if (
          s.totalBytes === null ||
          s.availableBytes === null ||
          s.availableBytes > s.totalBytes ||
          (s.totalInodes !== null &&
            (s.availableInodes === null || s.availableInodes > s.totalInodes))
        )
          throw Error('invalid');
        return {
          role: m.role,
          path: m.path,
          totalBytes: s.totalBytes,
          availableBytes: s.availableBytes,
          totalInodes: s.totalInodes > 0 ? s.totalInodes : null,
          availableInodes: s.totalInodes > 0 ? s.availableInodes : null,
          cause:
            s.availableInodes === 0 && s.totalInodes > 0
              ? 'inodes_exhausted'
              : s.availableBytes === 0
                ? 'space_exhausted'
                : null,
        };
      });
      return { checkedAt: v.checkedAt, mounts };
    } catch {
      /* Never use application log content as a trusted observation. */
    }
  }
  return null;
}

function safeStorageLimits(value) {
  if (!value || value.backend !== 'tmpfs' || value.memoryCharged !== true)
    return null;
  const fields = [
    'workspaceMb',
    'cacheMb',
    'temporaryMb',
    'dataMb',
    'inodesPerVolume',
  ];
  if (
    fields.some(
      (k) =>
        !Number.isSafeInteger(value[k]) || value[k] < 1 || value[k] > 16777216,
    )
  )
    return null;
  return {
    backend: 'tmpfs',
    memoryCharged: true,
    ...Object.fromEntries(fields.map((k) => [k, value[k]])),
  };
}
function safeStorageStatus(value) {
  const limits = safeStorageLimits(value?.limits);
  if (!limits) return null;
  return {
    limits,
    observation: value.observation
      ? readStorageObservation(
          JSON.stringify({ version: 1, ...value.observation }),
        )
      : null,
  };
}
module.exports = {
  previewStorage,
  storageMounts,
  cacheEnvironment,
  storageSample,
  readStorageObservation,
  safeStorageLimits,
  safeStorageStatus,
};
