/** Real Next.js Webpack HMR through TLS + PreviewGateway. No installed instance, cookie copying or CSP bypass. */
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
  mkdir,
  symlink,
  cp,
} from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
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
let nextProcess, gateway, front, browser, page;
let serverLogs = '';
const tunnels = new Set();
try {
  await commitReceipt();
  const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const fixture = path.join(repository, 'scripts/fixtures/next-hmr');
  await cp(
    path.join(fixture, 'package.json'),
    path.join(scratch, 'package.json'),
  );
  await symlink(
    path.join(fixture, 'node_modules'),
    path.join(scratch, 'node_modules'),
    'dir',
  );
  await mkdir(path.join(scratch, 'app'));
  for (const file of [
    'preview-next-state.cjs',
    'preview-next-css-loader.cjs',
    'preview-next-config.mjs',
    'preview-next-client.cjs',
    'preview-next-server.mjs',
  ])
    await cp(path.join(repository, 'runtime', file), path.join(scratch, file));
  await writeFile(
    path.join(scratch, 'next.config.mjs'),
    `import { withMergeronPreview } from './preview-next-config.mjs'; export default withMergeronPreview({ allowedDevOrigins: ['existing.preview.example'], devIndicators: false });`,
  );
  await writeFile(
    path.join(scratch, 'app/layout.js'),
    `import './style.css'; export default function Layout({children}) { return <html><head><meta name="mergeron-preview-generation" content={process.env.MERGERON_PREVIEW_BUILD_GENERATION}/></head><body>{children}</body></html>; }`,
  );
  await writeFile(
    path.join(scratch, 'app/page.js'),
    `'use client'; import { useEffect } from 'react'; export default function Page(){ useEffect(()=> { window.previewDocumentId ??= crypto.randomUUID(); }, []); return <button id="probe">Next HMR proof</button>; }`,
  );
  await writeFile(path.join(scratch, 'app/style.css'), '#probe{width:120px}');
  const reserve = http.createServer();
  const appPort = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve));
  nextProcess = spawn(
    process.execPath,
    [path.join(scratch, 'preview-next-server.mjs')],
    {
      cwd: scratch,
      env: {
        ...process.env,
        PORT: String(appPort),
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        MERGERON_PREVIEW_RECEIPT_PATH: receiptFile,
        MERGERON_PREVIEW_PUBLIC_HOST: host,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [nextProcess.stdout, nextProcess.stderr])
    stream.on('data', (data) => {
      serverLogs = (serverLogs + data.toString()).slice(-32768);
    });
  const readyBy = Date.now() + 60000;
  while (true) {
    if (nextProcess.exitCode !== null || nextProcess.signalCode !== null)
      throw Error('Next fixture exited: ' + serverLogs);
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) break;
      if (response.status === 500)
        throw Error('Next fixture compilation failed: ' + serverLogs);
    } catch (error) {
      if (error.message.startsWith('Next fixture compilation failed:'))
        throw error;
      /* Wait for bounded local fixture startup. */
    }
    if (Date.now() > readyBy)
      throw Error('Next fixture did not start: ' + serverLogs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  await writeFile(path.join(scratch, 'app/style.css'), '#probe{width:32px}');
  // Reproduce the transfer order: CSS can finish HMR before the Manager
  // atomically publishes the receipt. The adapter must refresh its CSS marker.
  await application.waitForFunction(
    () => getComputedStyle(document.querySelector('#probe')).width === '32px',
  );
  assert.equal(
    await application.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--mergeron-preview-generation')
        .trim()
        .replace(/^['"]|['"]$/g, ''),
    ),
    a,
  );
  await commitReceipt();
  await stage('applied', 'passed');
  await stage('detection', 'passed');
  await stage('socket', 'passed');
  await stage('build', 'passed');
  await page.waitForFunction(
    () =>
      document.querySelector('#result')?.dataset.state === 'current' &&
      JSON.parse(document.querySelector('#observations').textContent)
        .generation === '44444444-4444-4444-8444-444444444444',
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
    'Real Next.js Webpack HMR passed: authorized TLS proxy, receipt watcher, actual HMR socket and matching compilation hash, CSS 120px → 32px without reload, missing watcher generation, blocked WebSocket and revoked access.',
  );
} catch (error) {
  console.error('Next fixture server', serverLogs);
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
      .screenshot({
        path: '/tmp/mergeron-next-hmr-failure.png',
        fullPage: true,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  http.request = originalRequest;
  await browser?.close();
  for (const socket of tunnels) socket.destroy();
  await gateway?.close();
  if (
    nextProcess &&
    nextProcess.exitCode === null &&
    nextProcess.signalCode === null
  ) {
    nextProcess.kill('SIGTERM');
    await new Promise((resolve) => nextProcess.once('exit', resolve));
  }
  if (front) {
    front.closeAllConnections();
    await new Promise((resolve) => front.close(resolve));
  }
  await rm(scratch, { recursive: true, force: true });
}
