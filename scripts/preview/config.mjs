import {
  realpath,
  mkdir,
  readdir,
  readFile,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function port(value, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1024 || result > 65535)
    throw new Error('Preview ports must be integers between 1024 and 65535');
  return result;
}

export function configuration(env = process.env) {
  const frontendPort = port(env.PREVIEW_PORT, 3000);
  const backendPort = port(env.PREVIEW_BACKEND_PORT, 3001);
  if (frontendPort === backendPort)
    throw new Error('Preview ports must differ');
  const host = env.PREVIEW_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host))
    throw new Error('Unsupported preview bind address');
  let publicUrl;
  // Mergeron's executor supplies this exact host, never a request header.
  const managedHost = env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS;
  const publicOrigin =
    env.PREVIEW_PUBLIC_URL ??
    (managedHost && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(managedHost)
      ? `https://${managedHost}`
      : undefined);
  if (publicOrigin) {
    publicUrl = new URL(publicOrigin);
    if (
      publicUrl.protocol !== 'https:' ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.search ||
      publicUrl.hash ||
      publicUrl.pathname !== '/'
    )
      throw new Error(
        'PREVIEW_PUBLIC_URL must be an HTTPS origin without credentials',
      );
  }
  const allowedHosts = (env.PREVIEW_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedHosts.some((s) => !/^\.?[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(s)))
    throw new Error('Invalid PREVIEW_ALLOWED_HOSTS');
  return {
    dataDirectory: resolve(
      env.PREVIEW_DATA_DIR ?? join(repository, 'artifacts/preview-state'),
    ),
    frontendPort,
    backendPort,
    host,
    publicUrl,
    httpsHmr: env.PREVIEW_HMR_HTTPS === 'true',
    allowedHosts: [...allowedHosts, ...(publicUrl ? [publicUrl.hostname] : [])],
    username: env.PREVIEW_ADMIN_USERNAME ?? 'maxime',
    password: env.PREVIEW_ADMIN_PASSWORD,
    seedAdmin: env.PREVIEW_SEED_ADMIN === 'true',
  };
}

/** Adopt only a new directory or state previously initialized by this launcher. */
export async function prepareDirectory(directory) {
  const requested = resolve(directory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const actual = await realpath(requested);
  if (actual !== requested)
    throw new Error('Preview data directory must not contain symlinks');
  const sourceWithinData = relative(actual, repository);
  if (!sourceWithinData.startsWith('..') && !isAbsolute(sourceWithinData))
    throw new Error('Preview data directory must not contain the repository');
  const marker = join(actual, '.mergeron-preview.json');
  const entries = await readdir(actual);
  if (entries.length) {
    if (
      !entries.includes('.mergeron-preview.json') ||
      !(await lstat(marker)).isFile()
    )
      throw new Error(
        'Refusing nonempty directory not owned by the preview launcher',
      );
    const ownership = JSON.parse(await readFile(marker, 'utf8'));
    if (ownership.owner !== 'mergeron-preview' || ownership.version !== 1)
      throw new Error('Invalid preview ownership marker');
  } else {
    await writeFile(
      marker,
      JSON.stringify({ owner: 'mergeron-preview', version: 1 }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  for (const name of ['home', 'codex', 'workspaces', 'logs']) {
    const target = join(actual, name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    if ((await realpath(target)) !== target)
      throw new Error(`Preview ${name} must not be a symlink`);
  }
  for (const name of [
    'mergeron-test.sqlite',
    'mergeron-test.sqlite-wal',
    'mergeron-test.sqlite-shm',
    'webui-auth.json',
    'admin-credentials.json',
    'ai-unavailable.cjs',
  ]) {
    try {
      if (!(await lstat(join(actual, name))).isFile())
        throw new Error(`Preview ${name} must be a regular file`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return actual;
}

/** Carry toolchain/proxy settings, never the caller's application or AI secrets. */
export function backendEnvironment(config, env = process.env) {
  const allowed =
    /^(PATH|TMPDIR|LANG|LC_ALL|TZ|XDG_CACHE_HOME|COREPACK_HOME|PNPM_HOME|npm_config_(cache|store_dir|devdir|nodedir)|pnpm_config_store_dir|PLAYWRIGHT_BROWSERS_PATH|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy)$/;
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => allowed.test(name)),
    ),
    NODE_ENV: 'test',
    PORT: String(config.backendPort),
    LOG_LEVEL: 'info',
    HOME: join(config.dataDirectory, 'home'),
    CODEX_HOME: join(config.dataDirectory, 'codex'),
    WEBUI_DB_PATH: join(config.dataDirectory, 'mergeron-test.sqlite'),
    WEBUI_AUTH_CONFIG_PATH: join(config.dataDirectory, 'webui-auth.json'),
    WORKSPACE_ROOTS: join(config.dataDirectory, 'workspaces'),
    WEBUI_API_KEY: randomBytes(32).toString('hex'),
    WEBUI_REQUIRE_IDENTITY: 'false',
    MERGERON_PREVIEW_SETUP: 'true',
    CODEX_BIN: join(config.dataDirectory, 'ai-unavailable.cjs'),
    ...(config.publicUrl
      ? { MERGERON_PUBLIC_URL: config.publicUrl.origin }
      : {}),
  };
}
