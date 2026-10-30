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

export function environmentBackupPolicy(manifest) {
  if (manifest.environment === 'production') return PRODUCTION_ESSENTIAL;
  if (manifest.environment === 'development' && manifest.stack !== 'mergeron')
    return DEV_NO_BACKUP;
  throw new Error('updateBackupPolicyInvalid');
}

export function recordedBackupPolicy(operation) {
  const policy =
    operation.backupPolicy === undefined ? LEGACY_FULL : operation.backupPolicy;
  if (![DEV_NO_BACKUP, PRODUCTION_ESSENTIAL, LEGACY_FULL].includes(policy))
    throw new Error('updateBackupPolicyInvalid');
  if (
    (policy === DEV_NO_BACKUP && operation.environment !== 'development') ||
    (policy === PRODUCTION_ESSENTIAL && operation.environment !== 'production')
  )
    throw new Error('updateBackupPolicyInvalid');
  return policy;
}

export function backupEntries(policy) {
  if (policy === DEV_NO_BACKUP) return [];
  if (policy === PRODUCTION_ESSENTIAL)
    return persistentEntries.filter((name) => name !== 'logs');
  if (policy === LEGACY_FULL) return [...persistentEntries];
  throw new Error('updateBackupPolicyInvalid');
}

export function updateConfirmation(policy) {
  return policy === DEV_NO_BACKUP
    ? 'UPDATE_WITHOUT_DATA_BACKUP'
    : 'UPDATE_WITH_ROLLBACK';
}

export function rollbackConfirmation(policy) {
  return policy === DEV_NO_BACKUP
    ? 'ROLLBACK_IMAGES_ONLY'
    : 'ROLLBACK_WITH_DATA_RESTORE';
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
