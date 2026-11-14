/** Real Vite HMR through TLS + PreviewGateway. No installed instance, cookie copying or CSP bypass. */
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
import { mergeronPreview } from '../runtime/preview-vite-plugin.mjs';
import gatewayModule from '../runtime/preview-gateway.cjs';
const { PreviewGateway, PreviewAccessError } = gatewayModule;
const previewId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const host = previewId + '.preview.fixture.test',
  origin = 'https://' + host;
const a = '33333333-3333-4333-8333-333333333333',
  b = '44444444-4444-4444-8444-444444444444';
const c = '55555555-5555-4555-8555-555555555555';
const scratch = await realpath(
  await mkdtemp(path.join(tmpdir(), 'mergeron-hmr-')),
);
const receiptFile = path.join(scratch, '.mergeron-preview-receipt.json');
let generation = a,
  blockWebSocket = false,
  authorized = true;
const receipt = () => ({
  schemaVersion: 1,
  generation,
  archiveSha: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
  copyId: 'copy',
  gitCommit: null,
  syncedAt: Date.now(),
});
const commitReceipt = async () => {
  await writeFile(receiptFile + '.tmp', JSON.stringify(receipt()));
  await rename(receiptFile + '.tmp', receiptFile);
};
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
const originalRequest = http.request;
let vite, gateway, front, browser, page;
const tunnels = new Set();
try {
  await commitReceipt();
  await writeFile(
    path.join(scratch, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><button id="probe">HMR proof</button><script type="module" src="/main.js"></script></body></html>',
  );
  await writeFile(
    path.join(scratch, 'main.js'),
    'window.previewDocumentId = crypto.randomUUID();',
  );
  await writeFile(path.join(scratch, 'style.css'), '#probe{width:120px}');
  vite = await createServer({
    root: scratch,
    configFile: false,
    logLevel: 'error',
    plugins: [mergeronPreview({ receiptPath: receiptFile })],
    server: {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [host],
      hmr: { host, protocol: 'wss', clientPort: 443, path: '/__vite_hmr' },
      headers: {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss://" +
          host,
      },
    },
  });
  await vite.listen();
  const appPort = vite.httpServer.address().port;
  http.request = (options, ...args) =>
    originalRequest.call(
      http,
      options?.hostname === `pv-${runId.replaceAll('-', '')}-relay`
        ? { ...options, hostname: '127.0.0.1', port: appPort }
        : options,
      ...args,
    );
  gateway = new PreviewGateway({
    domain: 'preview.fixture.test',
    verifySource: async () => true,
    authorize: async () => {
      if (!authorized) throw new PreviewAccessError('permission_denied');
      return {
        endpoint: `http://pv-${runId.replaceAll('-', '')}-relay:8180`,
        token: 'd'.repeat(64),
        publicHost: host,
        expiresAt: Date.now() + 600000,
        receipt: receipt(),
      };
    },
  });
  const gatewayPort = await listen(gateway.server);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      path.join(scratch, 'key.pem'),
      '-out',
      path.join(scratch, 'cert.pem'),
      '-subj',
      '/CN=' + host,
    ],
    { stdio: 'ignore' },
  );
  front = https.createServer(
    {
      key: await readFile(path.join(scratch, 'key.pem')),
      cert: await readFile(path.join(scratch, 'cert.pem')),
    },
    (req, res) => {
      const upstream = originalRequest(
        {
          hostname: '127.0.0.1',
          port: gatewayPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    },
  );
  front.on('upgrade', (req, socket, head) => {
    if (blockWebSocket) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const upstream = originalRequest({
      hostname: '127.0.0.1',
      port: gatewayPort,
      path: req.url,
      headers: req.headers,
    });
    upstream.on('upgrade', (reply, remote, pending) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(reply.headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join('') +
          '\r\n',
      );
      if (head.length) remote.write(head);
      if (pending.length) socket.write(pending);
      tunnels.add(socket);
      socket.on('close', () => {
        tunnels.delete(socket);
        remote.destroy();
      });
      remote.on('close', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      remote.on('error', () => socket.destroy());
      socket.pipe(remote);
      remote.pipe(socket);
    });
    upstream.on('response', (reply) =>
      socket.end('HTTP/1.1 ' + reply.statusCode + ' Rejected\r\n\r\n'),
    );
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  const port = await listen(front);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: [
      `--host-resolver-rules=MAP ${host} 127.0.0.1:${port}`,
      '--no-proxy-server',
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'fr-FR',
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(20000);
  page = await context.newPage();
  page.on('pageerror', (e) => console.error('HMR fixture:', e.stack));
  const open = async (page) => {
    const link = await gateway.mint(
      {
        previewId,
        runId,
        projectId: 'p',
        threadId: 't',
        identity: { kind: 'person', personId: 'person' },
      },
      '/.__mergeron_preview/verify?path=%2F',
    );
    await page.goto(link.url);
    await page.locator('#result').waitFor();
  };
  const stage = async (name, expected) => {
    await page.waitForFunction(
      ([name, expected]) =>
        document.querySelector('#chain-' + name)?.dataset.state === expected,
      [name, expected],
    );
  };
  await open(page);
  await stage('socket', 'passed');
  await stage('detection', 'passed');
  await page.locator('details').first().locator('summary').click();
  await page.locator('#selector').fill('#probe');
  await page.locator('#property').fill('width');
  await page.locator('#expected').fill('32px');
  const application = page.frames().find((f) => f.url() === origin + '/');
  assert.ok(application);
  const documentId = await application.evaluate(() => window.previewDocumentId);
  assert.ok(documentId);
  await page.locator('#monitor').click();
  generation = b;
  await writeFile(path.join(scratch, 'style.css'), '#probe{width:32px}');
  await commitReceipt();
  await stage('applied', 'passed');
  await stage('detection', 'passed');
  await stage('socket', 'passed');
  await stage('build', 'passed');
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'hmrApplied',
  );
  assert.equal(
    await application
      .locator('#probe')
      .evaluate((e) => getComputedStyle(e).width),
    '32px',
  );
  assert.equal(
    await application.evaluate(() => window.previewDocumentId),
    documentId,
    'CSS HMR must not reload the document',
  );
  await page.locator('#monitor').click();
  const output = process.env.PREVIEW_HMR_OUTPUT;
  if (output) {
    await page.screenshot({ path: output + '-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: output + '-mobile.png', fullPage: true });
  }
  // A transfer generation not observed by the dev-server watcher is not confirmed.
  generation = c;
  await page.locator('#check').click();
  await stage('detection', 'pendingStage');
  generation = b;
  // Break the real public WS route while ordinary HTTP still works.
  blockWebSocket = true;
  for (const socket of tunnels) socket.destroy();
  await page.locator('#check').click();
  await stage('socket', 'failed');
  await stage('detection', 'passed');
  await stage('applied', 'passed');
  authorized = false;
  await page.locator('#check').click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'accessDenied',
  );
  console.log(
    'Real Vite HMR passed: authorized TLS proxy, receipt watcher, actual HMR socket round-trip, CSS 120px → 32px without reload, missing watcher generation, blocked WebSocket and revoked access.',
  );
} catch (error) {
  if (page) {
    console.error(
      'HMR diagnostic',
      await page
        .locator('#result')
        .textContent()
        .catch(() => 'missing'),
    );
    console.error(
      'HMR observation',
      await page
        .locator('#observations')
        .textContent()
        .catch(() => 'missing'),
    );
    console.error(
      'HMR frames',
      await Promise.all(
        page.frames().map(async (f) => ({
          url: f.url(),
          width: await f
            .locator('#probe')
            .evaluate((e) => getComputedStyle(e).width)
            .catch(() => null),
        })),
      ),
    );
    await page
      .screenshot({ path: '/tmp/mergeron-hmr-failure.png', fullPage: true })
      .catch(() => {});
  }
  throw error;
} finally {
  http.request = originalRequest;
  await browser?.close();
  for (const socket of tunnels) socket.destroy();
  await gateway?.close();
  await vite?.close();
  if (front) {
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
  }
  await rm(scratch, { recursive: true, force: true });
}
