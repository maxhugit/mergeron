import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  optionsFrom,
  proxyFrom,
  safeUrl,
  waitForUrl,
} from './visual-check.mjs';

test('requires a real URL and a visible selector, or an autonomous smoke', () => {
  assert.throws(() => optionsFrom([]), /required/);
  assert.throws(
    () => optionsFrom(['--url', 'file:///etc/passwd', '--selector', 'body']),
    /HTTP/,
  );
  assert.throws(
    () =>
      optionsFrom([
        '--url',
        'https://user:secret@example.com',
        '--selector',
        'body',
      ]),
    /credentials/,
  );
  assert.throws(
    () => optionsFrom(['--smoke', '--start', 'node server.js']),
    /cannot be combined/,
  );
  assert.throws(() => optionsFrom(['--smoke', '--timeout', 'NaN']), /Timeout/);
  assert.throws(
    () => optionsFrom(['--smoke', '--timeout', '600001']),
    /Timeout/,
  );
  assert.throws(() => optionsFrom(['--unknown']), /Invalid option/);
  const options = optionsFrom([
    '--smoke',
    '--cwd',
    '/tmp',
    '--output',
    'proof',
  ]);
  assert.equal(options.output, '/tmp/proof');
  assert.equal(options.selector, '#ready');
  assert.equal(options.text, 'Visual verification ready');
});

test('supports a server command and strips sensitive URL fields in reports', () => {
  const options = optionsFrom([
    '--url',
    'http://127.0.0.1:4173',
    '--selector',
    'h1',
    '--text',
    'Welcome',
    '--start',
    'pnpm dev',
    '--timeout',
    '5000',
  ]);
  assert.equal(options.start, 'pnpm dev');
  assert.equal(options.timeout, 5000);
  assert.equal(
    safeUrl('https://user:password@example.com/page?token=secret#fragment'),
    'https://example.com/page',
  );
});

test('passes the configured proxy and bypass without printing credentials', () => {
  assert.equal(proxyFrom({}), undefined);
  assert.deepEqual(
    proxyFrom({
      HTTPS_PROXY: 'http://user:se%21cret@proxy:3128',
      NO_PROXY: 'localhost,site',
    }),
    {
      server: 'http://proxy:3128',
      username: 'user',
      password: 'se!cret',
      bypass: 'localhost,site',
    },
  );
  assert.equal(
    proxyFrom({ http_proxy: 'http://proxy:3128' }).bypass,
    '127.0.0.1,localhost',
  );
});

test('waits for HTTP success, disposes responses and detects server exit', async () => {
  let calls = 0,
    disposed = 0;
  const request = {
    get: async () => ({
      status: () => (++calls === 1 ? 503 : 200),
      dispose: async () => disposed++,
    }),
  };
  await waitForUrl(request, 'http://localhost:4173', 1000);
  assert.equal(calls, 2);
  assert.equal(disposed, 2);
  await assert.rejects(
    waitForUrl(request, 'http://localhost:4173', 100, { exitCode: 1 }),
    /exited with code 1/,
  );
  await assert.rejects(
    waitForUrl(
      {
        get: async () => {
          throw new Error('TLS failed');
        },
      },
      'https://example.com/?token=secret',
      20,
    ),
    /Site did not become ready/,
  );
});
