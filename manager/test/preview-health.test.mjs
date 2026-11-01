import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { probePreview, relayReadiness } from '../src/preview-health.mjs';
import { spawnSync } from 'node:child_process';
afterEach(() => mock.restoreAll());
test('only fresh, structured results from the owned relay healthcheck announce readiness', () => {
  const now = Date.now();
  const health = {
    Status: 'healthy',
    Log: [
      {
        End: new Date(now).toISOString(),
        ExitCode: 0,
        Output: JSON.stringify({ ready: true, httpStatus: 302 }),
      },
    ],
  };
  assert.deepEqual(relayReadiness(health, now), {
    ready: true,
    httpStatus: 302,
  });
  assert.equal(relayReadiness(health, now, now + 1).ready, false);
  for (const value of [
    undefined,
    { Status: 'healthy' },
    { ...health, Status: 'unhealthy' },
    {
      ...health,
      Log: [{ ...health.Log[0], End: new Date(now - 10001).toISOString() }],
    },
    {
      ...health,
      Log: [{ ...health.Log[0], End: new Date(now + 2001).toISOString() }],
    },
    { ...health, Log: [{ ...health.Log[0], ExitCode: 1 }] },
    {
      ...health,
      Log: [{ ...health.Log[0], Output: 'private unstructured diagnostic' }],
    },
    {
      ...health,
      Log: [
        {
          ...health.Log[0],
          Output: JSON.stringify({ ready: true, httpStatus: 503 }),
        },
      ],
    },
    {
      ...health,
      Log: [
        {
          ...health.Log[0],
          Output: JSON.stringify({
            ready: true,
            httpStatus: 200,
            token: 'secret',
          }),
        },
      ],
    },
  ])
    assert.equal(relayReadiness(value, now).ready, false);
});
test('probe process rejects invalid control metadata without outputting diagnostics or capabilities', () => {
  const result = spawnSync(
    process.execPath,
    ['manager/src/preview-health-probe.mjs'],
    {
      env: {
        MERGERON_PREVIEW_PUBLIC_HOST: 'invalid',
        MERGERON_PREVIEW_TRANSPORT_TOKEN: 'secret-never-output',
      },
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 1024,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ready: false,
    httpStatus: null,
  });
});
const input = {
  runId: '22222222-2222-4222-8222-222222222222',
  publicHost: '11111111-1111-4111-8111-111111111111.preview.example.org',
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
  assert.equal(observed.headers.host, input.publicHost);
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
    {
      ...input,
      publicHost: '11111111-1111-4111-8111-111111111111.other.example',
    },
    { ...input, publicHost: 'arbitrary.preview.example.org' },
  ])
    assert.deepEqual(await probePreview(value), {
      ready: false,
      httpStatus: null,
    });
  assert.equal(request.mock.callCount(), 0);
});
