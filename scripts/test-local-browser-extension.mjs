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
    await rpc(mergeron, 'pair', {
      sessionId,
      threadId: 'agent',
      annotationProtocol: 3,
    }),
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
  await page.evaluate(() => {
    const hidden = document.createElement('div');
    hidden.style.opacity = '0';
    hidden.innerHTML = '<span>PRIVATE_HIDDEN_TEXT</span>';
    document.body.append(hidden);
  });
  let observation = await execute('observe');
  assert.match(observation.text, /Safe test page/);
  assert.equal(
    JSON.stringify(observation).includes('PRIVATE_INPUT_VALUE'),
    false,
  );
  assert.equal(
    JSON.stringify(observation).includes('PRIVATE_HIDDEN_TEXT'),
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
  // Headless cannot grant native activeTab through the toolbar. Supply a genuine
  // screenshot of this synthetic fixture to the capture API only; production
  // captureVisibleTab permissions must still be verified manually on each browser.
  await page.bringToFront();
  const pixels =
    'data:image/jpeg;base64,' +
    (await page.screenshot({ type: 'jpeg', quality: 75 })).toString('base64');
  await worker.evaluate((pixels) => {
    chrome.tabs.captureVisibleTab = async () => pixels;
  }, pixels);
  // Nothing leaves the extension before the editor's explicit submit.
  await popupCall('point', { id: sessionId });
  await page.locator('#save').hover();
  assert.equal(await page.locator('[data-mergeron-pointer]').isVisible(), true);
  const editorOpened = context.waitForEvent('page');
  await page.locator('#save').click();
  const editor = await editorOpened;
  await editor.waitForURL(
    `chrome-extension://${extensionId}/annotation.html#*`,
  );
  await editor.locator('#submit:not([disabled])').waitFor();
  assert.equal(
    (await rpc(mergeron, 'state', { sessionId })).annotation,
    undefined,
  );
  assert.ok((await execute('observe')).error);
  await editor.locator('#comment').fill('Please improve this button');
  const preview = await editor.locator('#preview').getAttribute('src');
  if (process.env.ANNOTATION_PREVIEW_PATH)
    await editor.screenshot({ path: process.env.ANNOTATION_PREVIEW_PATH });
  assert.match(preview, /^data:image\/jpeg;base64,/);
  // Processed preview masks the input. It is the exact image later delivered.
  const fieldBox = await page.locator('#name').boundingBox();
  const color = await editor.evaluate(
    async ({ x, y }) => {
      const img = document.querySelector('#preview');
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    },
    { x: fieldBox.x + fieldBox.width / 2, y: fieldBox.y + fieldBox.height / 2 },
  );
  assert.ok(
    Math.abs(color[0] - 52) < 12 &&
      Math.abs(color[1] - 65) < 12 &&
      Math.abs(color[2] - 85) < 12,
  );
  await editor.locator('#submit').click();
  const ready = (await rpc(mergeron, 'state', { sessionId })).annotation;
  assert.ok(ready?.id);
  const annotation = await rpc(mergeron, 'annotation', {
    sessionId,
    annotationId: ready.id,
  });
  assert.equal(annotation.comment, 'Please improve this button');
  assert.equal(annotation.selection.text, 'Save');
  assert.equal(annotation.image, preview);
  assert.notEqual(annotation.image, pixels);
  assert.ok(
    (await rpc(other, 'annotation', { sessionId, annotationId: ready.id }))
      .error,
  );
  await rpc(mergeron, 'annotationAck', { sessionId, annotationId: ready.id });
  assert.equal(
    (await rpc(mergeron, 'state', { sessionId })).annotation,
    undefined,
  );
  assert.equal(await page.locator('#count').innerText(), '1');
  await page.bringToFront();
  const cancelledEditor = context.waitForEvent('page');
  await popupCall('point', { id: sessionId });
  await page.locator('#save').click();
  const cancelled = await cancelledEditor;
  await cancelled.waitForURL(
    `chrome-extension://${extensionId}/annotation.html#*`,
  );
  await cancelled.locator('#submit:not([disabled])').waitFor();
  await cancelled
    .locator('#comment')
    .fill('Do not transmit this private draft');
  await cancelled.locator('#cancel').click();
  assert.equal(
    (await rpc(mergeron, 'state', { sessionId })).annotation,
    undefined,
  );
  await page.bringToFront();
  await popupCall('point', { id: sessionId });
  await page.locator('#save').hover();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-mergeron-pointer]').count(), 0);
  assert.equal(
    (await rpc(mergeron, 'state', { sessionId })).inputBlocked,
    false,
  );
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
  // Mergeron can be annotated but never read or clicked by its own agent.
  const selfId = await worker.evaluate(
    async () =>
      (
        await chrome.tabs.query({ url: 'https://mergeron.fixture.test/agent' })
      )[0].id,
  );
  const selfSession = crypto.randomUUID();
  await rpc(mergeron, 'pair', {
    sessionId: selfSession,
    threadId: 'self-annotation',
  });
  await popupCall('approvePair', { id: selfSession });
  assert.deepEqual(
    await popupCall('share', { id: selfSession, tabId: selfId }),
    { ok: true },
  );
  assert.equal(
    (await rpc(mergeron, 'state', { sessionId: selfSession })).annotationOnly,
    true,
  );
  assert.ok(
    (
      await rpc(mergeron, 'execute', {
        sessionId: selfSession,
        command: {
          action: 'observe',
          executionId: crypto.randomUUID(),
          expiresAt: Date.now() + 60_000,
        },
      })
    ).error,
  );
  await rpc(mergeron, 'revoke', { sessionId: selfSession });
  console.log(
    'PASS: MV3 pairing, sanitized observation, approved actions, blue hover frame, private comment editor, redacted screenshot preview, explicit annotation submission, cancellation, self-annotation without self-approval, navigation/authentication pause and revocation. Native capture permissions still require manual validation.',
  );
} finally {
  await context.close();
}
