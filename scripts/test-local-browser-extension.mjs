/** Real Chromium MV3 test. Only synthetic HTTPS fixtures; no user profile or credentials.
 * The harness pregrants its two fixture origins because a headless test cannot
 * click Chrome's native activeTab/optional-host permission UI. Production retains
 * optional single-instance permission + activeTab, tested separately by manifest assertions.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const source = fileURLToPath(
  new URL('../web/browser-extension/', import.meta.url),
);
const production = JSON.parse(
  await readFile(path.join(source, 'manifest.json'), 'utf8'),
);
assert.deepEqual(production.permissions, ['activeTab', 'scripting', 'storage']);
assert.equal(production.host_permissions, undefined);
assert.equal(production.externally_connectable, undefined);
assert.equal(production.manifest_version, 3);
const scratch = await mkdtemp(
  path.join(tmpdir(), 'mergeron-extension-fixture-'),
);
const extensionPath = path.join(scratch, 'extension');
await cp(source, extensionPath, { recursive: true });
await writeFile(
  path.join(extensionPath, 'manifest.json'),
  JSON.stringify({
    ...production,
    host_permissions: [
      'https://mergeron.fixture.test/*',
      'https://page.fixture.test/*',
    ],
  }),
);
const context = await chromium.launchPersistentContext(
  path.join(scratch, 'profile'),
  {
    headless: true,
    channel: 'chromium',
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  },
);
try {
  await context.route('https://**.fixture.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><title>Fixture</title><body><h1>Safe test page</h1><label for="name">Name</label><input id="name" value="PRIVATE_INPUT_VALUE"><button id="save">Save</button><div id="count">0</div><script>let clicks=0;document.querySelector("#save").onclick=()=>document.querySelector("#count").textContent=++clicks</script></body></html>',
    }),
  );
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#origin').fill('https://mergeron.fixture.test');
  await options
    .getByRole('button', { name: 'Autoriser cette instance' })
    .click();
  await options.getByText('Instance autorisée.', { exact: false }).waitFor();
  const mergeron = await context.newPage();
  await mergeron.goto('https://mergeron.fixture.test/agent');
  const rpc = async (page, action, payload) =>
    page.evaluate(
      ({ action, payload }) =>
        new Promise((resolve, reject) => {
          const channel = 'mergeron-local-browser-v1',
            id = crypto.randomUUID();
          const listener = (event) => {
            if (
              event.source === window &&
              event.data?.id === id &&
              event.data.kind === 'response'
            ) {
              clearTimeout(timer);
              window.removeEventListener('message', listener);
              resolve(event.data.result);
            }
          };
          const timer = setTimeout(() => {
            window.removeEventListener('message', listener);
            reject(Error('Bridge timeout'));
          }, 5000);
          window.addEventListener('message', listener);
          window.postMessage(
            { channel, kind: 'request', id, action, payload },
            location.origin,
          );
        }),
      { action, payload },
    );
  const sessionId = crypto.randomUUID();
  assert.deepEqual(
    await rpc(mergeron, 'pair', { sessionId, threadId: 'agent' }),
    { ok: true },
  );
  assert.equal((await rpc(mergeron, 'state', { sessionId })).state, 'pairing');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: 'Confirmer l’appairage' }).click();
  const page = await context.newPage();
  await page.goto(
    'https://page.fixture.test/document?secret=redacted#fragment',
  );
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ url: 'https://page.fixture.test/*' }))[0].id,
  );
  const popupCall = async (action, payload = {}) =>
    popup.evaluate(
      ({ action, payload }) =>
        chrome.runtime.sendMessage({
          channel: 'mergeron-local-browser-v1',
          action,
          payload,
        }),
      { action, payload },
    );
  const share = async () => {
    assert.deepEqual(await popupCall('share', { id: sessionId, tabId }), {
      ok: true,
    });
  };
  await share();
  const initial = await rpc(mergeron, 'state', { sessionId });
  assert.equal(initial.state, 'shared');
  assert.equal(initial.url, 'https://page.fixture.test/document');
  assert.ok(
    (
      await rpc(mergeron, 'execute', {
        sessionId,
        command: {
          id: crypto.randomUUID(),
          executionId: crypto.randomUUID(),
          action: 'observe',
          args: {},
          expiresAt: Date.now() - 1,
        },
      })
    ).error,
  );
  const execute = async (
    action,
    args = {},
    executionId = crypto.randomUUID(),
  ) =>
    rpc(mergeron, 'execute', {
      sessionId,
      command: {
        id: crypto.randomUUID(),
        executionId,
        action,
        args,
        expiresAt: Date.now() + 60_000,
      },
    });
  let observation = await execute('observe');
  assert.match(observation.text, /Safe test page/);
  assert.equal(
    JSON.stringify(observation).includes('PRIVATE_INPUT_VALUE'),
    false,
  );
  const field = observation.elements.find((entry) => entry.text === 'Name');
  assert.ok(field);
  assert.equal(
    (
      await execute('fill', {
        snapshotId: observation.snapshotId,
        elementId: field.id,
        value: 'Approved text',
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator('#name').inputValue(), 'Approved text');
  assert.equal(
    (
      await execute('click', {
        snapshotId: observation.snapshotId,
        elementId: field.id,
      })
    ).error,
    'STALE_PAGE_OBSERVE_AGAIN',
  );
  observation = await execute('observe');
  const button = observation.elements.find((entry) => entry.text === 'Save');
  const once = crypto.randomUUID();
  assert.equal(
    (
      await execute(
        'click',
        { snapshotId: observation.snapshotId, elementId: button.id },
        once,
      )
    ).ok,
    true,
  );
  assert.ok(
    (
      await execute(
        'click',
        { snapshotId: observation.snapshotId, elementId: button.id },
        once,
      )
    ).error,
  );
  assert.equal(await page.locator('#count').innerText(), '1');
  observation = await execute('observe');
  assert.equal(
    (
      await execute('navigate', {
        snapshotId: observation.snapshotId,
        url: 'https://other.fixture.test/',
      })
    ).error,
    'ORIGIN_DENIED',
  );
  // A different Mergeron tab cannot reuse a paired session.
  const other = await context.newPage();
  await other.goto('https://mergeron.fixture.test/other');
  assert.ok((await rpc(other, 'state', { sessionId })).error);
  // Execution markers are persisted before returning, not kept in worker globals.
  const retained = await worker.evaluate(
    async (id) => (await chrome.storage.session.get('slots')).slots[id],
    sessionId,
  );
  assert.equal(retained.paired, true);
  assert.ok(retained.seen.includes(once));
  // Pointer adds only evidence; pausing cancels any outstanding click interception.
  await popupCall('point', { id: sessionId });
  await page.locator('#save').click();
  assert.equal(
    (await rpc(mergeron, 'state', { sessionId })).selection.text,
    'Save',
  );
  assert.equal(await page.locator('#count').innerText(), '1');
  await popupCall('point', { id: sessionId });
  await popupCall('pause');
  await page.locator('#save').click();
  assert.equal(await page.locator('#count').innerText(), '2');
  assert.equal((await rpc(mergeron, 'state', { sessionId })).state, 'paused');
  await share();
  await page.reload();
  assert.equal((await rpc(mergeron, 'state', { sessionId })).state, 'paused');
  await share();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'password';
    input.value = 'DO_NOT_SHARE';
    document.body.append(input);
  });
  assert.equal(
    (await execute('observe')).error,
    'AUTHENTICATION_REQUIRED_PAUSE_AND_SIGN_IN_MANUALLY',
  );
  assert.equal((await rpc(mergeron, 'state', { sessionId })).state, 'paused');
  await rpc(mergeron, 'revoke', { sessionId });
  assert.ok(
    (
      await rpc(mergeron, 'execute', {
        sessionId,
        command: { action: 'observe', executionId: crypto.randomUUID() },
      })
    ).error,
  );
  console.log(
    'PASS: MV3 pairing, native tab sharing, sanitized observation, fill, at-most-once click, stale handles, origin isolation, pointer cancellation, navigation pause, authentication pause and revocation.',
  );
} finally {
  await context.close();
}
