import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import {
  configuration,
  backendEnvironment,
  prepareDirectory,
  repository,
} from './config.mjs';
import { initialize } from './initialize.mjs';
import { start, probe } from './start.mjs';

// Use the project's existing WebSocket implementation for the loopback probe.
const require = createRequire(join(repository, 'package.json'));
const engineRequire = createRequire(
  createRequire(require.resolve('socket.io')).resolve('engine.io'),
);
const { WebSocket } = engineRequire('ws');

test('keeps application/AI credentials out of the child and pins all state to preview data', () => {
  const config = configuration({ PREVIEW_DATA_DIR: '/tmp/disposable-preview' });
  const env = backendEnvironment(config, {
    PATH: '/tools',
    HTTPS_PROXY: 'http://proxy',
    OPENAI_API_KEY: 'forbidden',
    WEBUI_DB_PATH: '/production.sqlite',
    CODEX_HOME: '/real-account',
    NODE_OPTIONS: '--require=unexpected',
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(
    env.WEBUI_DB_PATH,
    '/tmp/disposable-preview/mergeron-test.sqlite',
  );
  assert.equal(env.CODEX_HOME, '/tmp/disposable-preview/codex');
  assert.equal(env.HTTPS_PROXY, 'http://proxy');
  assert.notEqual(env.WEBUI_API_KEY, backendEnvironment(config).WEBUI_API_KEY);
  assert.throws(() => configuration({ PREVIEW_PORT: '3001' }), /differ/);
  assert.throws(() => configuration({ PREVIEW_ALLOWED_HOSTS: '*' }), /Invalid/);
  assert.throws(
    () =>
      configuration({ PREVIEW_PUBLIC_URL: 'https://user:secret@example.org' }),
    /HTTPS origin/,
  );
});

test('refuses to adopt an existing data directory without its marker', async () => {
  const directory = await temporary();
  try {
    await writeFile(
      join(directory, 'existing.sqlite'),
      'existing application data',
    );
    await assert.rejects(prepareDirectory(directory), /Refusing nonempty/);
    assert.equal(
      await readFile(join(directory, 'existing.sqlite'), 'utf8'),
      'existing application data',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporary() {
  const parent = join(repository, 'artifacts/preview-tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'run-'));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function http(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        let result = '';
        res.on('data', (chunk) => (result += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: result,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test(
  'real preview: generated password, preserved admin, cookie login through Vite, HMR and shutdown',
  { timeout: 180000 },
  async () => {
    const directory = await temporary();
    const config = configuration({
      PREVIEW_DATA_DIR: directory,
      PREVIEW_PORT: String(await freePort()),
      PREVIEW_BACKEND_PORT: String(await freePort()),
      PREVIEW_ADMIN_USERNAME: 'preview-tester',
    });
    let running;
    let socket;
    const moduleName = `.preview-hmr-${randomUUID()}.js`;
    const modulePath = join(repository, 'web', moduleName);
    try {
      running = await start(config);
      const credentialPath = join(directory, 'admin-credentials.json');
      const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
      assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
      assert.ok(credentials.password.length >= 12);
      await initialize({ ...config, password: 'A-different-test-password' });
      assert.deepEqual(
        JSON.parse(await readFile(credentialPath, 'utf8')),
        credentials,
      );
      const origin = `http://127.0.0.1:${config.frontendPort}`;
      const login = await http(config.frontendPort, '/api/auth/local-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(credentials),
      });
      assert.equal(login.status, 200, login.body);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      assert.match(login.headers['set-cookie'][0], /HttpOnly/);
      const roots = await http(config.frontendPort, '/api/files/roots', {
        headers: { cookie },
      });
      assert.equal(roots.status, 200, roots.body);
      assert.equal(
        (await http(config.frontendPort, '/api/files/roots')).status,
        401,
      );
      const client = await http(config.frontendPort, '/@vite/client');
      assert.equal(client.status, 200);
      assert.match(client.body, /createHotContext/);
      socket = new WebSocket(
        `ws://127.0.0.1:${config.frontendPort}/?token=${running.vite.config.webSocketToken}`,
        'vite-hmr',
      );
      const received = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('HMR message timeout')),
          10000,
        );
        socket.addEventListener('message', (event) => {
          const payload = JSON.parse(event.data);
          if (
            payload.type === 'custom' &&
            payload.event === 'preview:verification'
          ) {
            clearTimeout(timeout);
            resolve();
          }
        });
        socket.addEventListener(
          'error',
          () => {
            clearTimeout(timeout);
            reject(new Error('HMR socket failed'));
          },
          { once: true },
        );
        socket.addEventListener(
          'open',
          () =>
            running.vite.hot.send({
              type: 'custom',
              event: 'preview:verification',
              data: { ok: true },
            }),
          { once: true },
        );
      });
      await received;
      await writeFile(
        modulePath,
        'export const value = 1; if (import.meta.hot) import.meta.hot.accept();',
        { flag: 'wx' },
      );
      assert.equal(
        (await http(config.frontendPort, `/${moduleName}`)).status,
        200,
      );
      const updated = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Source HMR update timeout')),
          10000,
        );
        socket.addEventListener('message', (event) => {
          const payload = JSON.parse(event.data);
          if (
            payload.type === 'update' &&
            payload.updates.some((update) => update.path.includes(moduleName))
          ) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await writeFile(
        modulePath,
        'export const value = 2; if (import.meta.hot) import.meta.hot.accept();',
      );
      await updated;
      socket.close();
      await running.stop();
      await assert.rejects(probe(config.backendPort, '/api/auth/methods'));
      await assert.rejects(probe(config.frontendPort, '/@vite/client'));
    } finally {
      socket?.close();
      await running?.stop();
      await rm(modulePath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
