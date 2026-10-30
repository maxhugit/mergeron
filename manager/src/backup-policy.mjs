/** Versioned policies: recovery uses the recorded policy, never today's defaults. */
export const persistentEntries = [
  'home',
  'workspace',
  'logs',
  'ssh',
  'config',
  'backend-token.txt',
  'backend-token-nginx.txt',
  'openai-api-key.txt',
];
export const DEV_NO_BACKUP = 'development-none-v1';
export const PRODUCTION_ESSENTIAL = 'production-essential-v1';
export const LEGACY_FULL = 'legacy-full-v1';
export const FULL = 'full-v1';
export const MINIMAL = 'minimal-v1';
export const NONE = 'none-v1';
export const backupModes = { full: FULL, minimal: MINIMAL, none: NONE };
export const withoutDataBackup = (policy) =>
  [DEV_NO_BACKUP, NONE].includes(policy);

export function environmentBackupPolicy(manifest, mode) {
  if (
    manifest.environment !== 'production' &&
    !(manifest.environment === 'development' && manifest.stack !== 'mergeron')
  )
    throw new Error('updateBackupPolicyInvalid');
  if (mode !== undefined) {
    if (typeof mode !== 'string' || !Object.hasOwn(backupModes, mode))
      throw new Error('updateBackupPolicyInvalid');
    return backupModes[mode];
  }
  if (manifest.environment === 'production') return PRODUCTION_ESSENTIAL;
  if (manifest.environment === 'development' && manifest.stack !== 'mergeron')
    return DEV_NO_BACKUP;
  throw new Error('updateBackupPolicyInvalid');
}

export function recordedBackupPolicy(operation) {
  const policy =
    operation.backupPolicy === undefined ? LEGACY_FULL : operation.backupPolicy;
  if (
    ![
      DEV_NO_BACKUP,
      PRODUCTION_ESSENTIAL,
      LEGACY_FULL,
      FULL,
      MINIMAL,
      NONE,
    ].includes(policy)
  )
    throw new Error('updateBackupPolicyInvalid');
  if (
    (policy === DEV_NO_BACKUP && operation.environment !== 'development') ||
    (policy === PRODUCTION_ESSENTIAL && operation.environment !== 'production')
  )
    throw new Error('updateBackupPolicyInvalid');
  return policy;
}

export function backupEntries(policy) {
  if (withoutDataBackup(policy)) return [];
  if (policy === MINIMAL)
    return persistentEntries.filter(
      (name) => !['home', 'workspace', 'logs'].includes(name),
    );
  if (policy === PRODUCTION_ESSENTIAL)
    return persistentEntries.filter((name) => name !== 'logs');
  if ([LEGACY_FULL, FULL].includes(policy)) return [...persistentEntries];
  throw new Error('updateBackupPolicyInvalid');
}

export function updateConfirmation(policy) {
  return withoutDataBackup(policy)
    ? 'UPDATE_WITHOUT_DATA_BACKUP'
    : 'UPDATE_WITH_ROLLBACK';
}

export function rollbackConfirmation(policy) {
  return withoutDataBackup(policy)
    ? 'ROLLBACK_IMAGES_ONLY'
    : 'ROLLBACK_WITH_DATA_RESTORE';
}

/** Explicit leaves only: never copy CODEX_HOME, sessions or webui wholesale. */
export function minimalHomeEntries(environment = []) {
  const env = Object.fromEntries(
    environment.map((entry) => {
      const index = entry.indexOf('=');
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  const home = env.CODEX_HOME || '/home/codex/.codex';
  const database = env.WEBUI_DB_PATH || `${home}/codex-webui.sqlite`;
  const relative = (path) => {
    if (
      !path.startsWith('/home/codex/') ||
      path
        .split('/')
        .slice(1)
        .some((part) => !part || part === '..' || part === '.')
    )
      throw new Error('updateMinimalBackupPathUnsupported');
    return `home/${path.slice('/home/codex/'.length)}`;
  };
  const entries = [
    ...['', '-wal', '-shm', '-journal', '.push-vapid.json'].map((suffix) =>
      relative(`${database}${suffix}`),
    ),
    ...['config.toml', 'auth.json', 'AGENTS.md', 'webui/model-catalog'].map(
      (name) => relative(`${home}/${name}`),
    ),
    'home/.gitconfig',
  ];
  if (
    new Set(entries).size !== entries.length ||
    entries.some((entry, index) =>
      entries.some(
        (other, otherIndex) =>
          index !== otherIndex && entry.startsWith(`${other}/`),
      ),
    )
  )
    throw new Error('updateMinimalBackupPathUnsupported');
  return entries;
}

/** Skip only directories, never follow links or classify generic build/dist as disposable. */
export function excludesBackupDirectory(policy, relativePath) {
  if (policy !== PRODUCTION_ESSENTIAL) return false;
  const [root, ...parts] = relativePath.split('/');
  if (root === 'home') {
    const home = parts.join('/');
    return [
      '.cache',
      '.npm',
      '.pnpm-store',
      '.yarn/cache',
      '.local/share/pnpm/store',
    ].includes(home);
  }
  if (root !== 'workspace') return false;
  // All document versions and agent drafts are irreplaceable, even when a
  // user gives a document/folder a name that looks like a dependency/cache.
  if (parts[0] === '.mergeron-agent-drafts') return false;
  // Back up pre-migration histories/drafts too, before a newer app moves them.
  if (
    parts.some((part) =>
      ['.mergeron', '.webui', '.agent-document-drafts'].includes(part),
    )
  )
    return false;
  if (parts[0] === '.mergeron-system')
    return parts.length === 3 && parts[2] === 'previews';
  if (['documents', 'livrables'].includes(parts[1])) return false;
  const name = parts.at(-1);
  return [
    'node_modules',
    '.build-cache',
    '.pnpm-store',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '__pycache__',
  ].includes(name);
}
