import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { probePreview } from '../src/preview-health.mjs';
afterEach(() => mock.restoreAll());
const input = {
  runId: '22222222-2222-4222-8222-222222222222',
  domain: 'preview.example.org',
  path: '/health',
  token: 'a'.repeat(64),
};
test('HTTP readiness uses only the fixed relay with its private capability, without following a redirect', async () => {
  const response = {
    statusCode: 302,
    headers: { location: 'http://private.invalid' },
    destroy() {},
  };
  let observed;
  const mocked = mock.method(http, 'request', (options, callback) => {
    observed = options;
    const request = Object.assign(new EventEmitter(), {
      end() {
        callback(response);
      },
      destroy() {},
    });
    return request;
  });
  assert.deepEqual(await probePreview(input), { ready: true, httpStatus: 302 });
  assert.equal(mocked.mock.callCount(), 1);
  assert.equal(observed.hostname, 'pv-22222222222242228222222222222222-relay');
  assert.equal(observed.port, 8180);
  assert.equal(observed.path, '/health');
  assert.equal(observed.headers.host, input.runId + '.' + input.domain);
  assert.equal(observed.headers['x-mergeron-preview-transport'], input.token);
});
test('HTTP errors and unavailable transport never claim readiness', async () => {
  mock.method(http, 'request', (_, callback) =>
    Object.assign(new EventEmitter(), {
      end() {
        callback({ statusCode: 500, destroy() {} });
      },
      destroy() {},
    }),
  );
  assert.deepEqual(await probePreview(input), {
    ready: false,
    httpStatus: 500,
  });
  mock.restoreAll();
  mock.method(http, 'request', () => {
    const request = Object.assign(new EventEmitter(), {
      end() {
        request.emit('error', Error('private diagnostic'));
      },
      destroy() {},
    });
    return request;
  });
  assert.deepEqual(await probePreview(input), {
    ready: false,
    httpStatus: null,
  });
});
test('cannot probe an arbitrary host, URL, invalid target or transport token', async () => {
  const request = mock.method(http, 'request', () => {
    throw Error('must not connect');
  });
  for (const value of [
    { ...input, path: 'https://private.invalid' },
    { ...input, runId: 'arbitrary-host' },
    { ...input, token: '' },
    { ...input, domain: 'bad@host' },
  ])
    assert.deepEqual(await probePreview(value), {
      ready: false,
      httpStatus: null,
    });
  assert.equal(request.mock.callCount(), 0);
});
