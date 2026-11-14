'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, writeFile, rename, symlink, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const a = '33333333-3333-4333-8333-333333333333';
const b = '44444444-4444-4444-8444-444444444444';
function server() {
  let middleware;
  const value = {
    ws: new EventEmitter(),
    httpServer: new EventEmitter(),
    middlewares: {
      use: (handler) => {
        middleware = handler;
      },
    },
  };
  return {
    value,
    status() {
      let body,
        next = false;
      middleware(
        { url: '/__mergeron_hmr/status', method: 'GET' },
        {
          setHeader() {},
          end: (s) => {
            body = s;
          },
        },
        () => {
          next = true;
        },
      );
      assert.equal(next, false);
      return JSON.parse(body);
    },
  };
}
test('Vite detects atomic receipt replacement and never exposes arbitrary receipt contents or transport secrets', async () => {
  const { mergeronPreview } = await import('./preview-vite-plugin.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'preview-vite-'));
  const file = path.join(directory, 'receipt.json');
  const s = server();
  try {
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        generation: a,
        private: 'DO_NOT_EXPOSE',
      }),
    );
    const plugin = mergeronPreview({ receiptPath: file });
    plugin.configureServer(s.value);
    assert.equal(s.status().generation, a);
    await writeFile(
      file + '.next',
      JSON.stringify({ schemaVersion: 1, generation: b }),
    );
    await rename(file + '.next', file);
    for (let n = 0; n < 100 && s.status().generation !== b; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.status().generation, b);
    const socket = {};
    s.value.ws.emit('connection', socket, {
      headers: { 'x-mergeron-preview-transport': 'PRIVATE_TRANSPORT' },
    });
    let ack;
    s.value.ws.emit(
      'mergeron-preview:probe',
      { id: 'probe', extra: 'DO_NOT_EXPOSE' },
      {
        socket,
        send: (_name, data) => {
          ack = data;
        },
      },
    );
    assert.deepEqual(ack, { id: 'probe', generation: b, viaPreview: true });
    assert.equal(JSON.stringify(s.status()).includes('DO_NOT_EXPOSE'), false);
    s.value.ws.emit(
      'mergeron-preview:probe',
      { id: 'direct' },
      {
        socket: {},
        send: (_name, data) => {
          ack = data;
        },
      },
    );
    assert.equal(ack.viaPreview, false);
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        generation: 'PRIVATE_INVALID_GENERATION',
      }),
    );
    for (let n = 0; n < 100 && s.status().generation !== null; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.status().generation, null);
    assert.equal(plugin.transform('body{}', '/style.css'), undefined);
  } finally {
    s.value.httpServer.emit('close');
    await rm(directory, { recursive: true, force: true });
  }
});
test('Vite integration refuses receipt symlinks and leaves production integration disabled without a receipt path', async () => {
  const { mergeronPreview } = await import('./preview-vite-plugin.mjs');
  assert.equal(mergeronPreview({ receiptPath: '' }), false);
  const directory = await mkdtemp(path.join(tmpdir(), 'preview-vite-link-'));
  const s = server();
  try {
    const target = path.join(directory, 'private.json');
    await writeFile(
      target,
      JSON.stringify({ schemaVersion: 1, generation: a }),
    );
    const file = path.join(directory, 'receipt.json');
    await symlink(target, file);
    const plugin = mergeronPreview({ receiptPath: file });
    plugin.configureServer(s.value);
    assert.equal(s.status().generation, null);
    assert.equal(plugin.apply, 'serve');
    assert.equal(plugin.transform('body{}', '/style.module.css'), undefined);
  } finally {
    s.value.httpServer.emit('close');
    await rm(directory, { recursive: true, force: true });
  }
});
