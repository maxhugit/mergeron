/** Outer mount boundary: a Codex approval cannot make these mounts writable. */
import * as path from 'node:path';

export interface DocumentIsolationPlan {
  home: string;
  databasePath: string;
  writableRoots: string[];
  publishedRoots: string[];
  unavailableRoots?: string[];
}

const PRIVATE_ENV =
  /^(?:WEBUI_|MERGERON_|OIDC_|AUTHENTIK_|SESSION_|DATABASE_|DB_)/i;

export function documentProtectionEnabled(environment = process.env): boolean {
  return (
    environment.MERGERON_PUBLISHED_DOCUMENT_PROTECTION === 'required' ||
    environment.MERGERON_STACK_ENVIRONMENT === 'development'
  );
}

/** Never pass Mergeron's administrative credentials to shell descendants. */
export function documentAgentEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !PRIVATE_ENV.test(key) &&
        key !== 'OPENAI_API_KEY_FILE' &&
        key !== 'SSH_AUTH_SOCK',
    ),
  );
}

export function documentIsolationArgs(
  plan: DocumentIsolationPlan,
  binary: string,
  args: string[],
): string[] {
  const roots = [
    ...new Set(plan.writableRoots.map((root) => path.resolve(root))),
  ];
  if (
    roots.some((root) =>
      [
        '/',
        '/appdata',
        '/home',
        '/home/codex',
        '/run',
        '/proc',
        '/app',
      ].includes(root),
    )
  )
    throw new Error(
      'An overly broad workspace cannot isolate published documents',
    );
  if (
    roots.some(
      (root) => root !== '/workspaces' && !root.startsWith('/workspaces/'),
    )
  )
    throw new Error(
      'Protected agents require a working copy under /workspaces',
    );
  const result = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/appdata',
    '--tmpfs',
    '/run/secrets',
    '--tmpfs',
    '/run/mergeron-manager',
    '--bind',
    plan.home,
    plan.home,
    '--tmpfs',
    path.join(path.dirname(plan.home), '.ssh'),
  ];
  for (const root of roots) result.push('--bind', root, root);
  // Overlay after every writable bind, including nested workspace roots.
  for (const root of [...new Set(plan.publishedRoots)].sort())
    result.push('--ro-bind', root, root);
  // Missing paths are masked inside the namespace only, never recreated on disk.
  for (const root of [...new Set(plan.unavailableRoots ?? [])].sort()) {
    if (!root.startsWith('/workspaces/'))
      throw new Error('Invalid unavailable workspace boundary');
    result.push('--tmpfs', root, '--remount-ro', root);
  }
  // SQLite's sidecars must not expose identities, sessions or server settings.
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    result.push('--ro-bind', '/dev/null', plan.databasePath + suffix);
  result.push('--', binary, ...args);
  return result;
}
