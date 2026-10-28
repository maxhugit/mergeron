/** Real WebKit page engine with a simulated browser.runtime, NOT native Safari
 * extension validation. Only intercepted HTTPS fixtures, no profiles/credentials.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webkit } from 'playwright-core';

const source = await readFile(
  new URL('../web/browser-extension/tab-agent.js', import.meta.url),
  'utf8',
);
const bridge = await readFile(
  new URL('../web/browser-extension/bridge.js', import.meta.url),
  'utf8',
);
const imageProcessor = await readFile(
  new URL('../web/browser-extension/annotation-image.js', import.meta.url),
  'utf8',
);
const browser = await webkit.launch(
  process.env.WEBKIT_EXECUTABLE_PATH
    ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH }
    : {},
);
try {
  const page = await browser.newPage();
  await page.route('https://**.fixture.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><title>WebKit fixture</title><body><h1>Visible title</h1><label for="name">Name</label><input id="name" value="PRIVATE_INPUT"><button id="save">Save</button><div id="count">0</div><div style="opacity:0"><span>PRIVATE_HIDDEN</span></div><script>let clicks=0;document.querySelector("#save").onclick=()=>document.querySelector("#count").textContent=++clicks</script></body></html>',
    }),
  );
  await page.goto('https://page.fixture.test/document?token=SECRET#private');
  await page.evaluate(() => {
    globalThis.__listeners = [];
    globalThis.__captures = [];
    // No chrome namespace: exercise the actual Safari-style code path.
    globalThis.browser = {
      runtime: {
        id: 'fixture',
        sendMessage: async (message) => {
          globalThis.__captures.push(message);
          return { ok: true };
        },
        onMessage: {
          addListener: (listener) => globalThis.__listeners.push(listener),
        },
      },
    };
  });
  await page.addScriptTag({ content: source });
  const message = (payload) =>
    page.evaluate(
      (payload) =>
        new Promise((resolve) => {
          globalThis.__listeners[0](
            { channel: 'mergeron-local-browser-v1', ...payload },
            { id: 'fixture' },
            resolve,
          );
        }),
      payload,
    );
  const { documentId } = await message({ action: 'init' });
  const command = (action, args = {}) =>
    message({
      action: 'command',
      documentId,
      command: { action, args, expiresAt: Date.now() + 60_000 },
    });
  let reading = await command('observe');
  assert.match(reading.text, /Visible title/);
  assert.equal(JSON.stringify(reading).includes('PRIVATE_INPUT'), false);
  assert.equal(JSON.stringify(reading).includes('PRIVATE_HIDDEN'), false);
  assert.equal(reading.url, 'https://page.fixture.test/document');
  const input = reading.elements.find((item) => item.text === 'Name');
  assert.ok(input);
  assert.equal(
    (
      await command('fill', {
        snapshotId: reading.snapshotId,
        elementId: input.id,
        value: 'Approved',
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator('#name').inputValue(), 'Approved');
  assert.equal(
    (
      await command('click', {
        snapshotId: reading.snapshotId,
        elementId: input.id,
      })
    ).error,
    'STALE_PAGE_OBSERVE_AGAIN',
  );
  reading = await command('observe');
  const button = reading.elements.find((item) => item.text === 'Save');
  assert.equal(
    (
      await command('click', {
        snapshotId: reading.snapshotId,
        elementId: button.id,
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator('#count').innerText(), '1');
  await message({ action: 'point', documentId });
  await page.locator('#save').hover();
  assert.equal(await page.locator('[data-mergeron-pointer]').isVisible(), true);
  await page.locator('#save').click();
  await page.waitForFunction(() => globalThis.__captures.length === 1);
  const capture = (await page.evaluate(() => globalThis.__captures))[0];
  assert.equal(capture.payload.selection.text, 'Save');
  assert.equal(capture.action, 'captureAnnotation');
  assert.ok(capture.payload.geometry.masks.length > 0);
  assert.equal(
    (await message({ action: 'state', documentId })).selection,
    undefined,
  );
  const screenshot =
    'data:image/jpeg;base64,' +
    (await page.screenshot({ type: 'jpeg' })).toString('base64');
  const marked = await page.evaluate(
    async ({ imageProcessor, screenshot, geometry }) => {
      const url = URL.createObjectURL(
        new Blob([imageProcessor], { type: 'text/javascript' }),
      );
      try {
        const { markCapture } = await import(url);
        return await markCapture(screenshot, geometry);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { imageProcessor, screenshot, geometry: capture.payload.geometry },
  );
  assert.match(marked, /^data:image\/jpeg;base64,/);
  assert.notEqual(marked, screenshot);
  assert.equal(await page.locator('#count').innerText(), '1');
  await message({ action: 'point', documentId });
  await message({ action: 'stop', documentId });
  await page.locator('#save').click();
  assert.equal(await page.locator('#count').innerText(), '2');
  const next = await message({ action: 'init' });
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.type = 'password';
    document.body.append(field);
  });
  assert.equal(
    (
      await message({
        action: 'command',
        documentId: next.documentId,
        command: { action: 'observe', expiresAt: Date.now() + 60_000 },
      })
    ).error,
    'AUTHENTICATION_REQUIRED_PAUSE_AND_SIGN_IN_MANUALLY',
  );
  // Test the production bridge with a Promise-only browser.runtime surface.
  await page.evaluate(() => {
    globalThis.__relayed = [];
    globalThis.browser.runtime.sendMessage = async (message) => {
      globalThis.__relayed.push(message);
      return { ok: true };
    };
  });
  await page.addScriptTag({ content: bridge });
  const response = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => reject(Error('Bridge timeout')), 3000);
        const listener = (event) => {
          if (event.data?.id !== id || event.data.kind !== 'response') return;
          clearTimeout(timeout);
          window.removeEventListener('message', listener);
          resolve(event.data.result);
        };
        window.addEventListener('message', listener);
        window.postMessage(
          {
            channel: 'mergeron-local-browser-v1',
            kind: 'request',
            action: 'pair',
            id,
            payload: { sessionId: crypto.randomUUID(), threadId: 'agent' },
          },
          location.origin,
        );
      }),
  );
  assert.deepEqual(response, { ok: true });
  assert.equal((await page.evaluate(() => globalThis.__relayed)).length, 1);
  console.log(
    'PASS: WebKit page code with browser-only API, privacy, approved input, stale handles, pointer, authentication pause and bridge. Native Safari install still requires manual validation.',
  );
} finally {
  await browser.close();
}
