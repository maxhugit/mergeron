/** Trusted manual fixture for mergeron-visual-check --start. Real Nest/Fastify
 * and real built SPA; separate database/config/home, no account or inference.
 * Run this and the visual check in ONE agent command (same network namespace).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const repository = fs.realpathSync(process.argv[2] || process.cwd());
assert(
  fs.statSync(path.join(repository, 'dist/main.js')).isFile(),
  'Build the real backend first',
);
assert(
  fs.statSync(path.join(repository, 'public/index.html')).isFile(),
  'Build the real SPA first',
);
const artifacts = path.resolve(
  process.argv[3] || path.join(repository, 'artifacts'),
);
fs.mkdirSync(artifacts, { recursive: true });
const state = fs.mkdtempSync(path.join(artifacts, 'netlink-backend-test-'));
for (const name of ['home/.codex', 'database', 'workspace', 'logs'])
  fs.mkdirSync(path.join(state, name), { recursive: true, mode: 0o700 });
fs.symlinkSync(
  path.join(repository, 'drizzle'),
  path.join(state, 'drizzle'),
  'dir',
);
const key = randomBytes(32).toString('hex'); // disposable test service, never logged
// An immediately exiting /bin/false races the older client's first stdin write
// and raises an unrelated EPIPE. Reject the AI handshake explicitly instead:
// this tests the real HTTP backend in its supported unavailable-runtime state,
// never an AI account, model response or a fabricated successful Codex server.
const unavailableRuntime = path.join(state, 'codex-unavailable.cjs');
fs.writeFileSync(
  unavailableRuntime,
  [
    '#!/usr/bin/env node',
    "const readline = require('node:readline');",
    "if (process.argv.includes('--version')) {",
    "  console.error('Fixture only: AI runtime intentionally unavailable');",
    '  process.exit(1);',
    '}',
    'readline.createInterface({ input: process.stdin }).on(\'line\', (line) => {',
    '  let request;',
    '  try { request = JSON.parse(line); } catch { return; }',
    "  if (request.id === undefined) return;",
    '  process.stdout.write(JSON.stringify({',
    '    id: request.id,',
    "    error: { code: -32000, message: 'AI runtime intentionally unavailable in isolated backend fixture' },",
    "  }) + '\\n');",
    '});',
    '',
  ].join('\n'),
  { mode: 0o700, flag: 'wx' },
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    [
      'PATH',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'COREPACK_HOME',
      'PNPM_HOME',
      'npm_config_cache',
      'npm_config_store_dir',
      'pnpm_config_store_dir',
      'npm_config_devdir',
      'npm_config_nodedir',
      'PLAYWRIGHT_BROWSERS_PATH',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
    ].includes(name),
  ),
);
const child = spawn(process.execPath, [path.join(repository, 'dist/main.js')], {
  cwd: state,
  env: {
    ...environment,
    NODE_ENV: 'test',
    PORT: '4174',
    LOG_LEVEL: 'info',
    HOME: path.join(state, 'home'),
    CODEX_HOME: path.join(state, 'home/.codex'),
    WEBUI_DB_PATH: path.join(state, 'database/test.sqlite'),
    WEBUI_AUTH_CONFIG_PATH: path.join(state, 'home/test-auth.json'),
    WORKSPACE_ROOTS: path.join(state, 'workspace'),
    WEBUI_API_KEY: key,
    WEBUI_REQUIRE_IDENTITY: 'false',
    // The fixture deliberately has no model runtime/account. HTTP startup and
    // the guide must work without it. Do not contact ChatGPT/GitHub in this test.
    CODEX_BIN: unavailableRuntime,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.once('error', () => {
  console.error('Test backend could not start');
  process.exitCode = 1;
});

// A loopback-only test ingress, analogous to the real deployment's service
// authentication. This key authorizes only the disposable database above.
const proxy = http.createServer((request, response) => {
  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: 4174,
      path: request.url,
      method: request.method,
      // This is explicitly the same sandbox's loopback, never an egress bypass.
      agent: new http.Agent(),
      headers: {
        ...request.headers,
        authorization: 'Bearer ' + key,
        'x-webui-auth-source': 'service',
      },
    },
    (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    },
  );
  upstream.once('error', () => {
    if (!response.headersSent) response.writeHead(503);
    response.end('Test backend not ready');
  });
  request.pipe(upstream);
});
proxy.listen(4173, '127.0.0.1', () =>
  console.log(
    'Isolated real backend fixture: http://127.0.0.1:4173/help; state=' + state,
  ),
);
const stop = () => {
  proxy.close();
  child.kill('SIGTERM');
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
child.once('exit', (code) => {
  proxy.close();
  if (code) process.exitCode = code;
});
