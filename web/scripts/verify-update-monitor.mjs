/** Synthetic local-only browser verification; never connects to a deployed stack. */
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createUpdateGateway } from '../../manager/src/update-monitor-gateway.mjs';
import {
  grantMonitor,
  publishMonitor,
} from '../../manager/src/update-monitor-journal.mjs';
const require = createRequire(import.meta.url);
const provider = createRequire(require.resolve('@vitest/browser-playwright'));
const { chromium, webkit } = provider('playwright');
const output = resolve(process.argv[2] ?? '.vitest-screenshots/update-monitor');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'mergeron-monitor-browser-'));
const upstream = http.createServer((req, res) => res.end('application'));
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const gateway = createUpdateGateway({
  directory,
  hostname: 'localhost',
  upstream: `http://127.0.0.1:${upstream.address().port}`,
});
await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
const url = `http://localhost:${gateway.address().port}`;
const reports = [];
// The independent page must work with no application process for the whole test.
await new Promise((r) => upstream.close(r));
try {
  for (const [engine, launcher] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await launcher.launch({ headless: true });
    try {
      for (const width of [390, 1280]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
        });
        try {
          const page = await context.newPage();
          const grant = await grantMonitor(directory);
          // Synthetic HTTP-only listener: the real session endpoint enforces Secure cookies and HTTPS Origin.
          await context.addCookies([
            {
              name: 'mergeron_update',
              value: grant.token,
              url,
              secure: false,
              httpOnly: true,
              sameSite: 'Strict',
            },
          ]);
          await publishMonitor(directory, {
            id: 'previous',
            phase: 'complete',
            status: 'succeeded',
            startedAt: new Date().toISOString(),
            events: [],
          });
          await page.goto(url + '/_mergeron-update/?exclude=previous&lang=fr');
          await page
            .getByText('En attente du démarrage de la nouvelle opération…', {
              exact: true,
            })
            .waitFor();
          const startedAt = new Date().toISOString();
          const events = [];
          for (const phase of [
            'stopping',
            'replacing',
            'managerReplacing',
            'managerChecking',
            'complete',
          ]) {
            events.push({
              at: new Date().toISOString(),
              phase,
              status: phase === 'complete' ? 'succeeded' : 'running',
            });
            await publishMonitor(directory, {
              id: 'current',
              phase,
              status: phase === 'complete' ? 'succeeded' : 'running',
              startedAt,
              events,
            });
            await page.waitForFunction(
              (expected) =>
                document.querySelectorAll('#events li').length === expected,
              events.length,
            );
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
              true,
            );
            assert.equal(
              await page.locator('#events li').count(),
              events.length,
            );
            if (phase === 'managerReplacing' && width === 1280) {
              const previousState = await page.locator('#state').innerText();
              const previousObserved = await page
                .locator('#observed')
                .innerText();
              let fault = 503;
              await page.route('**/_mergeron-update/status', (route) =>
                fault
                  ? route.fulfill({
                      status: fault,
                      contentType: 'application/json',
                      body: '{}',
                    })
                  : route.continue(),
              );
              await page.waitForFunction(() =>
                document
                  .querySelector('#connection')
                  .textContent.includes('Connexion au suivi interrompue'),
              );
              assert.equal(
                await page.locator('#state').innerText(),
                previousState,
              );
              assert.equal(
                await page.locator('#observed').innerText(),
                previousObserved,
              );
              assert.equal(
                await page.locator('#events li').count(),
                events.length,
              );
              fault = 401;
              await page.waitForFunction(() =>
                document
                  .querySelector('#connection')
                  .textContent.includes('session administrateur'),
              );
              assert.equal(
                await page.locator('#state').innerText(),
                previousState,
              );
              fault = 0;
              await page.waitForFunction(
                () =>
                  document.querySelector('#connection').textContent ===
                  'Suivi connecté',
              );
              await page.unroute('**/_mergeron-update/status');
            }
            if (phase === 'managerChecking')
              await page.screenshot({
                path: join(output, `${engine}-${width}.png`),
                fullPage: true,
              });
          }
          assert.match(
            await page.locator('#state').innerText(),
            /Mise à jour réussie/,
          );
          for (const [status, phase, label, checkpoint] of [
            ['rolledBack', 'complete', 'Version précédente restaurée', false],
            [
              'recoveryRequired',
              'managerRolledBack',
              'Intervention nécessaire',
              false,
            ],
            ['succeeded', 'complete', 'Sauvegarde créée', true],
          ]) {
            await publishMonitor(directory, {
              id: 'current',
              status,
              phase,
              checkpoint,
              startedAt,
              events,
            });
            await page.reload();
            await page
              .getByRole('heading', { name: label, exact: true })
              .waitFor();
            if (status !== 'succeeded')
              assert.notEqual(
                await page.locator('#track').getAttribute('aria-valuenow'),
                await page.locator('#track').getAttribute('aria-valuemax'),
              );
          }
          await publishMonitor(directory, {
            id: 'current',
            phase: 'stopping',
            status: 'running',
            startedAt,
            events: events.slice(0, 1),
          });
          await page.reload();
          await page
            .getByRole('heading', { name: 'Arrêt des services', exact: true })
            .waitFor();
          await publishMonitor(directory, {
            id: 'other',
            phase: 'complete',
            status: 'succeeded',
            startedAt,
            events: [],
          });
          await page.waitForFunction(() =>
            document
              .querySelector('#connection')
              .textContent.includes('Une autre opération est courante'),
          );
          assert.equal(
            await page.locator('#state').innerText(),
            'Arrêt des services',
          );
          assert.equal(await page.locator('#events li').count(), 1);
          reports.push({
            engine,
            width,
            events: events.length,
            overflow: false,
          });
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  const response = await fetch(url + '/', { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Suivi de la mise à jour/);
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(reports, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      checks: reports,
      upstreamStoppedHttpStatus: response.status,
    }),
  );
} finally {
  gateway.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise((r) => gateway.close(r)),
    new Promise((r) => upstream.close(r)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
