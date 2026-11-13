/** Synthetic HTTPS proxy + real authorized Chromium. No installed instance or user cookies. */
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import gatewayModule from '../runtime/preview-gateway.cjs';
const { PreviewGateway } = gatewayModule;
const previewId = '11111111-1111-4111-8111-111111111111',
  runId = '22222222-2222-4222-8222-222222222222';
const host = previewId + '.preview.fixture.test',
  origin = 'https://' + host;
const a = '33333333-3333-4333-8333-333333333333',
  b = '44444444-4444-4444-8444-444444444444';
let sourceCurrent = true;
let allowed = true,
  generation = a,
  htmlGeneration = a,
  cssGeneration = a,
  width = 120;
const base = {
  schemaVersion: 1,
  archiveSha: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
  copyId: 'copy',
  gitCommit: 'c'.repeat(40),
  syncedAt: Date.now(),
};
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
const scratch = await mkdtemp(path.join(tmpdir(), 'mergeron-preview-proof-'));
let browser, context, front, gateway, app;
const originalRequest = http.request;
try {
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
  // The internal container address is mapped to a fixture listener only in this harness.
  app = http.createServer((req, res) => {
    assert.equal(req.headers['x-mergeron-preview-transport'], 'd'.repeat(64));
    assert.equal(req.headers.cookie, undefined); // Gateway grants never reach the app.
    res.setHeader('cache-control', 'no-store');
    if (req.url.startsWith('/style.css')) {
      res.setHeader('content-type', 'text/css');
      res.end(
        `:root{--mergeron-preview-generation:"${cssGeneration}"}#probe{width:${width}px}`,
      );
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<html><head><meta name="mergeron-preview-generation" content="${htmlGeneration}"><link rel="stylesheet" href="/style.css"></head><body><button id="probe">Proof</button></body></html>`,
      );
    }
  });
  const appPort = await listen(app);
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
    verifySource: async () => sourceCurrent,
    authorize: async () => {
      if (!allowed) throw Error('revoked');
      return {
        endpoint: `http://pv-${runId.replaceAll('-', '')}-relay:8180`,
        token: 'd'.repeat(64),
        publicHost: host,
        expiresAt: Date.now() + 600000,
        receipt: { ...base, generation },
        syncError: null,
      };
    },
  });
  const gatewayPort = await listen(gateway.server);
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
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'fr-FR',
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('Fixture page:', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('Fixture console:', m.text());
  });
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
  console.log('Verification fixture opened', await page.title());
  const result = page.locator('#result');
  await result.waitFor();

  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'current',
  );
  assert.equal(new URL(page.url()).hash, '');
  sourceCurrent = false;
  await page.locator('#check').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#result')?.dataset.state === 'source_unverified',
  );
  sourceCurrent = true;
  generation = b;
  await page.locator('#check').click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'stale',
  );
  cssGeneration = b;
  width = 32;
  await page.locator('#check').click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'cssStale',
  );
  await page.locator('details').first().locator('summary').click();
  await page.locator('#selector').fill('#probe');
  await page.locator('#property').fill('width');
  await page.locator('#expected').fill('32px');
  htmlGeneration = b;
  await page.locator('#reload').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#result')?.dataset.state === 'current' &&
      document
        .querySelector('#observations')
        ?.textContent.includes('"matches": true'),
  );
  await page.locator('#expected').fill('33px');
  await page.locator('#check').click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'styleMismatch',
  );
  await page.locator('#expected').fill('32px');
  await page.locator('#check').click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'current',
  );
  const output = process.env.PREVIEW_VERIFICATION_OUTPUT;
  if (output) {
    await page.screenshot({ path: output + '-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: output + '-mobile.png', fullPage: true });
  }
  // A page with no markers must never inherit a successful generation proof.
  htmlGeneration = '';
  cssGeneration = '';
  await page.locator('#reload').click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'unknown',
  );
  allowed = false;
  await page.locator('#check').click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state === 'accessExpired',
  );
  console.log(
    'Preview verification passed: authorized HTTPS proxy, stale HTML, stale CSS, reload recovery, computed style, unknown build and revoked access.',
  );
} finally {
  http.request = originalRequest;
  await context?.close();
  await browser?.close();
  await gateway?.close();
  await Promise.all(
    [front, app].filter(Boolean).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
  await rm(scratch, { recursive: true, force: true });
}
