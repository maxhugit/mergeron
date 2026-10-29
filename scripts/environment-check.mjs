import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdtemp, mkdir, open, readFile, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const help = `Usage: mergeron-environment-check [--cwd <directory>] [--visual]
       [--url <http(s) URL>] [--timeout <milliseconds>] [--json]

Run from the agent terminal with its normal permissions, before installing/building.
Checks temporary writes, caches, offline package-manager versions, local Node
headers, and the configured proxy's DNS/TCP reachability. --visual also checks
loopback listening and sandboxed Chromium. --url requests only the supplied URL,
using curl's existing proxy/TLS settings. No install, project script or permission
change is performed. Temporary probes are removed; no report is saved by default.
This checks capabilities, not the application's rendering or registry access.
`;

export const cacheKeys = [
  'XDG_CACHE_HOME',
  'COREPACK_HOME',
  'npm_config_cache',
  'npm_config_store_dir',
  'pnpm_config_store_dir',
  'npm_config_devdir',
  'PNPM_HOME',
];

export function optionsFrom(args) {
  const options = {
    cwd: process.cwd(),
    timeout: 5_000,
    visual: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help' || name === '-h') return { help: true };
    if (name === '--visual' || name === '--json') {
      options[name.slice(2)] = true;
      continue;
    }
    const key = { '--cwd': 'cwd', '--timeout': 'timeout', '--url': 'url' }[
      name
    ];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Option invalide ou valeur manquante');
    options[key] = args[++i];
  }
  options.cwd = resolve(options.cwd);
  options.timeout = Number(options.timeout);
  if (
    !Number.isInteger(options.timeout) ||
    options.timeout < 100 ||
    options.timeout > 30_000
  )
    throw new Error('Le délai doit être compris entre 100 et 30000 ms');
  if (options.url) {
    let url;
    try {
      url = new URL(options.url);
    } catch {
      throw new Error('URL invalide');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Utiliser une URL HTTP(S) sans identifiants intégrés');
  }
  return options;
}

/** Report only stable codes, never child stderr, environment dumps or URL tokens. */
export function errorCode(error) {
  const code = String(error?.code ?? 'UNAVAILABLE');
  return /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : 'UNAVAILABLE';
}

export async function writableProbe(directory) {
  let probe;
  try {
    probe = await mkdtemp(join(directory, '.mergeron-environment-'));
    const file = await open(join(probe, 'probe'), 'wx', 0o600);
    try {
      await file.writeFile('probe');
    } finally {
      await file.close();
    }
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true });
  }
}

export function command(file, args, options) {
  return new Promise((done, reject) => {
    execFile(
      file,
      args,
      {
        ...options,
        maxBuffer: 8_192,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => (error ? reject(error) : done(stdout.trim())),
    );
  });
}

export async function localHeaders(root, version = process.versions.node) {
  if (!root) return false;
  const directory = join(root, 'include/node');
  const headers = await readFile(join(directory, 'node_version.h'), 'utf8');
  const actual = ['MAJOR', 'MINOR', 'PATCH']
    .map(
      (part) =>
        headers.match(
          new RegExp(`#define\\s+NODE_${part}_VERSION\\s+(\\d+)`),
        )?.[1],
    )
    .join('.');
  await readFile(join(directory, 'node.h'));
  await readFile(join(directory, 'config.gypi'));
  return actual === version;
}

export function proxyAddress(env) {
  const value =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Unsupported proxy');
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  };
}

/** curl ignores uppercase HTTP_PROXY; do not accidentally bypass that proxy. */
export function curlEnvironment(env) {
  const result = { ...env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (result[key.toLowerCase()] === undefined && result[key] !== undefined)
      result[key.toLowerCase()] = result[key];
  }
  return result;
}

function bounded(promise, timeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(), { code: 'ETIMEDOUT' })),
        timeout,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export function tcpProbe(address, timeout) {
  return new Promise((done, reject) => {
    const socket = createConnection({
      host: address.hostname,
      port: address.port,
    });
    const timer = setTimeout(
      () => finish(Object.assign(new Error(), { code: 'ETIMEDOUT' })),
      timeout,
    );
    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : done();
    };
    socket.once('connect', () => finish());
    socket.once('error', finish);
  });
}

export function loopbackProbe() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : done())),
    );
  });
}

export async function browserProbe(timeout) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: process.platform === 'linux',
    timeout,
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><h1>Environment ready</h1>', {
      timeout,
    });
    await page.locator('h1').waitFor({ state: 'visible', timeout });
  } finally {
    await browser.close();
  }
}

export async function run(options, deps = {}) {
  const env = deps.env ?? process.env;
  const execute = deps.command ?? command;
  const checks = [];
  const check = async (id, action, hint, warning = false) => {
    try {
      const detail = await action();
      checks.push({ id, status: 'ok', ...(detail ? { detail } : {}) });
      return true;
    } catch (error) {
      checks.push({
        id,
        status: warning ? 'warning' : 'failed',
        code: errorCode(error),
        hint,
      });
      return false;
    }
  };
  const missing = () => {
    throw Object.assign(new Error(), { code: 'NOT_CONFIGURED' });
  };
  await check(
    'workspace.write',
    () => (deps.writableProbe ?? writableProbe)(options.cwd),
    'Choisir un dossier autorisé en écriture ; ne pas élargir les protections.',
  );
  for (const key of cacheKeys) {
    await check(
      `cache.${key}`,
      async () => {
        if (!env[key]) missing();
        // Only the cache itself may be created, never a missing workspace root.
        await mkdir(env[key], { recursive: true, mode: 0o700 });
        await (deps.writableProbe ?? writableProbe)(env[key]);
      },
      'Relancer la session avec le lanceur de caches Mergeron ; vérifier les droits et l’espace disque.',
    );
  }
  let scratch;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'mergeron-preflight-'));
    for (const tool of ['npm', 'corepack', 'pnpm']) {
      await check(
        `tool.${tool}`,
        async () => {
          // No project-selected package-manager URL, download, auto-pin or script.
          const version = await execute(tool, ['--version'], {
            cwd: scratch,
            timeout: options.timeout,
            env: {
              ...env,
              COREPACK_ENABLE_NETWORK: '0',
              COREPACK_ENABLE_AUTO_PIN: '0',
              COREPACK_ENABLE_PROJECT_SPEC: '0',
            },
          });
          if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) missing();
          return version;
        },
        'Vérifier le gestionnaire préchargé dans l’image ; aucun téléchargement n’est tenté par ce contrôle.',
      );
    }
  } catch (error) {
    checks.push({
      id: 'tools.temporary-directory',
      status: 'failed',
      code: errorCode(error),
      hint: 'Le répertoire temporaire doit être accessible en écriture.',
    });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
  await check(
    'node.headers',
    async () => {
      if (!(await localHeaders(env.npm_config_nodedir))) missing();
    },
    'En-têtes locaux absents ou différents de Node ; les modules natifs peuvent nécessiter une configuration spécifique.',
    true,
  );

  let proxy;
  const parsed = await check(
    'proxy.configuration',
    () => {
      proxy = proxyAddress(env);
    },
    'Corriger la configuration du proxy, sans désactiver TLS ni contourner le filtrage.',
  );
  if (parsed && proxy) {
    const dnsOk = await check(
      'proxy.dns',
      () =>
        bounded((deps.lookup ?? lookup)(proxy.hostname), options.timeout).then(
          () => undefined,
        ),
      'Le nom du proxy ne se résout pas dans cette session ; vérifier le réseau autorisé et son DNS.',
    );
    if (dnsOk)
      await check(
        'proxy.tcp',
        () => (deps.tcpProbe ?? tcpProbe)(proxy, options.timeout),
        'Le proxy se résout mais ne répond pas ; vérifier son service et la connectivité autorisée.',
      );
  } else if (parsed) {
    checks.push({
      id: 'proxy.reachability',
      status: 'skipped',
      hint: 'Aucun proxy configuré ; cela ne prouve pas un accès direct autorisé.',
    });
  }
  if (options.url) {
    await check(
      'network.url',
      async () => {
        let status;
        try {
          status = await execute(
            'curl',
            [
              '--disable',
              '--silent',
              '--show-error',
              '--head',
              '--max-time',
              String(options.timeout / 1000),
              '--output',
              '/dev/null',
              '--write-out',
              '%{http_code}',
              '--url',
              options.url,
            ],
            {
              env: curlEnvironment(env),
              cwd: options.cwd,
              timeout: options.timeout + 1_000,
            },
          );
        } catch (error) {
          // Stable curl exit codes distinguish transport failures without stderr.
          const code = {
            5: 'PROXY_DNS',
            6: 'TARGET_DNS',
            7: 'CONNECTION_FAILED',
            28: 'ETIMEDOUT',
            35: 'TLS_FAILED',
            60: 'TLS_CERTIFICATE',
          }[error.code];
          throw Object.assign(new Error(), { code: code ?? errorCode(error) });
        }
        if (!/^[23]\d\d$/.test(status))
          throw Object.assign(new Error(), {
            code: /^\d{3}$/.test(status) ? `HTTP_${status}` : 'HTTP_FAILED',
          });
        return `HTTP ${status}`;
      },
      'La requête a échoué ou a été refusée ; vérifier le domaine autorisé, TLS et le proxy. Aucun contournement n’est appliqué.',
    );
  }
  if (options.visual) {
    await check(
      'visual.loopback',
      deps.loopbackProbe ?? loopbackProbe,
      'La session interdit l’écoute locale ; utiliser une autorisation adaptée, sans publier de port.',
    );
    await check(
      'visual.chromium',
      () => (deps.browserProbe ?? browserProbe)(options.timeout),
      'Chromium sandboxé ne démarre pas ; vérifier son installation et les permissions de namespace. Ne pas utiliser --no-sandbox.',
    );
  }
  return {
    success: !checks.some((item) => item.status === 'failed'),
    node: process.versions.node,
    platform: process.platform,
    cwd: options.cwd,
    scope:
      'Permissions du processus appelant uniquement ; ne valide ni le rendu du site ni les droits d’un autre contexte.',
    checks,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = optionsFrom(process.argv.slice(2));
    if (options.help) console.log(help);
    else {
      const report = await run(options);
      console.log(
        options.json
          ? JSON.stringify(report, null, 2)
          : [
              `Environnement : ${report.success ? 'prêt pour les contrôles demandés' : 'blocages détectés'}`,
              report.scope,
              ...report.checks.map(
                (item) =>
                  `${item.status.toUpperCase()} ${item.id}${item.detail ? ` : ${item.detail}` : ''}${item.code ? ` [${item.code}]` : ''}${item.hint ? ` — ${item.hint}` : ''}`,
              ),
            ].join('\n'),
      );
      if (!report.success) process.exitCode = 1;
    }
  } catch {
    console.error(
      'Contrôle impossible : vérifier les options et les permissions. Utiliser --help.',
    );
    process.exitCode = 1;
  }
}
