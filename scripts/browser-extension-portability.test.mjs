// Browser API contracts, not a substitute for an installed Safari extension.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { test } from 'node:test';
import {
  CHANNEL,
  bounded,
  safeUrl,
  instanceOrigin,
} from '../web/browser-extension/protocol.js';

const extensionRoot = new URL('../web/browser-extension/', import.meta.url);
const apiSource = await readFile(
  new URL('browser-api.js', extensionRoot),
  'utf8',
);
const workerSource = await readFile(
  new URL('worker.js', extensionRoot),
  'utf8',
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const event = () => ({
  listeners: [],
  addListener(listener) {
    this.listeners.push(listener);
  },
});

function fixture() {
  let session = {},
    local = {},
    authorized = true,
    registered = [];
  const messages = [],
    requests = [];
  const area = (read, write) => ({
    get: async () => structuredClone(read()),
    set: async (value) => write({ ...read(), ...structuredClone(value) }),
    clear: async () => write({}),
  });
  const browser = {
    storage: {
      session: area(
        () => session,
        (value) => {
          session = value;
        },
      ),
      local: area(
        () => local,
        (value) => {
          local = value;
        },
      ),
    },
    runtime: {
      id: 'safari-test',
      getURL: (file) => `safari-web-extension://fixture/${file}`,
      sendMessage: async () => {},
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
    },
    permissions: {
      contains: async (request) => {
        requests.push(plain(request));
        return authorized;
      },
      remove: async () => true,
      onRemoved: event(),
    },
    scripting: {
      registerContentScripts: async (scripts) => {
        registered.push(...plain(scripts));
      },
      unregisterContentScripts: async () => {
        registered = [];
      },
      executeScript: async () => {},
    },
    tabs: {
      get: async (id) => ({
        id,
        url: 'https://page.fixture.test/document',
        title: 'Fixture',
      }),
      sendMessage: async (_id, message) => {
        messages.push(plain(message));
        return message.action === 'init'
          ? { documentId: 'native-doc' }
          : { authRequired: false };
      },
      onUpdated: event(),
      onRemoved: event(),
    },
  };
  const context = vm.createContext({
    browser,
    CHANNEL,
    bounded,
    safeUrl,
    instanceOrigin,
    URL,
    crypto,
    setTimeout,
    clearTimeout,
  });
  // Evaluate the production module bodies against a Safari-only API surface.
  // Imports/exports are resolved here; no browser implementation is rewritten.
  vm.runInContext(
    apiSource.replace('export const extension', 'const extension') +
      '\n' +
      workerSource.replace(/^import .*;\n/gm, ''),
    context,
  );
  const call = (action, payload, sender) =>
    new Promise((resolve) => {
      const keep = browser.runtime.onMessage.listeners[0](
        { channel: CHANNEL, action, payload },
        sender,
        resolve,
      );
      assert.equal(keep, true);
    });
  const lifecycle = async (name) => {
    browser.runtime[name].listeners[0]();
    await vm.runInContext('operations', context);
  };
  return {
    browser,
    context,
    call,
    lifecycle,
    messages,
    requests,
    setAuthorized(value) {
      authorized = value;
    },
    registered: () => registered,
    session: () => session,
  };
}

test('prefers native browser promises, retains Chromium and fails without memory-only storage', () => {
  for (const name of ['browser', 'chrome']) {
    const value = fixture().browser;
    const context = vm.createContext({ [name]: value });
    vm.runInContext(
      apiSource.replace('export ', '') + '\nglobalThis.chosen = extension;',
      context,
    );
    assert.equal(context.chosen, value);
  }
  const native = fixture().browser;
  const context = vm.createContext({ browser: native, chrome: {} });
  vm.runInContext(
    apiSource.replace('export ', '') + '\nglobalThis.chosen = extension;',
    context,
  );
  assert.equal(context.chosen, native);
  assert.throws(
    () =>
      vm.runInNewContext(apiSource.replace('export ', ''), {
        browser: { ...native, storage: { local: native.storage.local } },
      }),
    /UNSUPPORTED_BROWSER/,
  );
});

const optionsSender = {
  id: 'safari-test',
  url: 'safari-web-extension://fixture/options.html',
};
const popupSender = {
  id: 'safari-test',
  url: 'safari-web-extension://fixture/popup.html',
};
const pageSender = {
  id: 'safari-test',
  frameId: 0,
  tab: { id: 1 },
  url: 'https://mergeron.fixture.test/agent',
};

test('Safari sender URLs pair and share, then updates restore only the authorized bridge and revoke sharing', async () => {
  const f = fixture();
  assert.deepEqual(
    plain(
      await f.call(
        'configure',
        { origin: 'https://mergeron.fixture.test' },
        optionsSender,
      ),
    ),
    { ok: true },
  );
  const id = crypto.randomUUID();
  await f.call('pair', { sessionId: id, threadId: 'agent' }, pageSender);
  await f.call('approvePair', { id }, popupSender);
  await f.call('share', { id, tabId: 2 }, popupSender);
  assert.equal(
    (await f.call('state', { sessionId: id }, pageSender)).state,
    'shared',
  );
  await f.lifecycle('onInstalled');
  assert.deepEqual(f.session(), {});
  assert.ok(f.messages.some((message) => message.action === 'stop'));
  assert.deepEqual(f.registered(), [
    {
      id: 'mergeron-bridge',
      matches: ['https://mergeron.fixture.test/*'],
      js: ['bridge.js'],
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
  assert.ok((await f.call('state', { sessionId: id }, pageSender)).error);
  assert.ok(
    f.requests.every(
      ({ origins }) => origins[0] === 'https://mergeron.fixture.test/*',
    ),
  );
  await f.lifecycle('onStartup');
  assert.equal(f.registered().length, 1);
});

test('revoked permission and malformed persisted origins never register new hosts', async () => {
  const f = fixture();
  await f.call(
    'configure',
    { origin: 'https://mergeron.fixture.test' },
    optionsSender,
  );
  f.setAuthorized(false);
  await f.lifecycle('onStartup');
  assert.deepEqual(f.registered(), []);
  assert.deepEqual(f.session(), {});
  f.setAuthorized(true);
  await f.browser.storage.local.set({
    origin: 'https://other.fixture.test/path?token=x',
  });
  await assert.rejects(f.lifecycle('onInstalled'), /HTTPS_ORIGIN_REQUIRED/);
  assert.deepEqual(f.registered(), []);
});

test('a website cannot impersonate Safari extension options or popup senders', async () => {
  const f = fixture();
  for (const sender of [
    { ...optionsSender, id: 'other-extension' },
    { ...optionsSender, url: 'https://mergeron.fixture.test/options.html' },
    { ...popupSender, url: 'safari-web-extension://unrelated/popup.html' },
  ])
    assert.ok(
      (
        await f.call(
          'configure',
          { origin: 'https://evil.fixture.test' },
          sender,
        )
      ).error,
    );
  assert.deepEqual(f.registered(), []);
});

function entries(zip) {
  const output = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0); // store-only ZIP
    const size = zip.readUInt32LE(offset + 18),
      names = zip.readUInt16LE(offset + 26),
      extra = zip.readUInt16LE(offset + 28);
    const name = zip
      .subarray(offset + 30, offset + 30 + names)
      .toString('utf8');
    const start = offset + 30 + names + extra;
    assert.ok(!name.includes('/') && !output.has(name));
    output.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  return output;
}

test('both deterministic packages contain the same reviewed scripts and permissions, with Safari manifest isolation', async () => {
  const script = new URL(
    '../web/scripts/package-browser-extension.mjs',
    import.meta.url,
  );
  await promisify(execFile)(process.execPath, [script.pathname]);
  const read = () =>
    Promise.all(
      ['', '-safari'].map((suffix) =>
        readFile(
          new URL(
            `../web/public/mergeron-browser-extension${suffix}.zip`,
            import.meta.url,
          ),
        ),
      ),
    );
  const [chromiumZip, safariZip] = await read();
  await promisify(execFile)(process.execPath, [script.pathname]);
  const again = await read();
  assert.deepEqual([chromiumZip, safariZip], again);
  const chromium = entries(chromiumZip),
    safari = entries(safariZip);
  assert.deepEqual([...chromium.keys()], [...safari.keys()]);
  for (const [file, content] of safari) {
    if (file !== 'manifest.json') {
      assert.deepEqual(content, chromium.get(file));
      assert.deepEqual(content, await readFile(new URL(file, extensionRoot)));
    }
  }
  const manifest = JSON.parse(safari.get('manifest.json'));
  const original = JSON.parse(chromium.get('manifest.json'));
  assert.equal(original.minimum_chrome_version, '120');
  assert.equal(original.browser_specific_settings, undefined);
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.deepEqual(manifest.browser_specific_settings, {
    safari: { strict_min_version: '18.4' },
  });
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  delete manifest.name;
  delete original.name;
  delete manifest.browser_specific_settings;
  delete original.minimum_chrome_version;
  assert.deepEqual(manifest, original);
});
