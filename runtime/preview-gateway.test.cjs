'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  PreviewGateway,
  appCookies,
  appSetCookie,
  clean,
} = require('./preview-gateway.cjs');
const previewId = '11111111-1111-4111-8111-111111111111',
  runId = '22222222-2222-4222-8222-222222222222';
const domain = 'preview.example.org',
  host = previewId + '.' + domain;
const grant = {
  previewId,
  runId,
  projectId: 'project',
  threadId: 'thread',
  identity: { kind: 'person', personId: 'person' },
};
function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = '') {
      this.body += body;
    },
  };
}
function request(url, body = {}, headers = {}) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    url,
    method: 'POST',
    headers: { host, origin: 'https://' + host, ...headers },
  });
}
test('direct access uses one-use, host/run-bound tickets without exposing them to the app', async () => {
  const gateway = new PreviewGateway({
    domain,
    authorize: async () => ({
      endpoint: 'http://pv-' + runId.replaceAll('-', '') + '-relay:8180',
      token: 'a'.repeat(64),
      publicHost: host,
      expiresAt: Date.now() + 600000,
    }),
  });
  const link = await gateway.mint(grant, '/page?test=1'),
    url = new URL(link.url);
  assert.equal(url.host, host);
  assert.equal(url.pathname, '/.__mergeron_preview/open');
  assert.equal(url.search, '');
  const token = new URLSearchParams(url.hash.slice(1)).get('mergeron-preview');
  const res = response();
  await gateway.handle(request('/.__mergeron_preview/session', { token }), res);
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['set-cookie'], /^__Host-mergeron_preview=/);
  assert.match(res.headers['set-cookie'], /HttpOnly/);
  assert.match(res.headers['set-cookie'], /Secure/);
  assert.doesNotMatch(res.headers['set-cookie'], /Domain=/);
  const cookie = res.headers['set-cookie'].split(';')[0];
  const access = await gateway.access(
    request('/', {}, { cookie }),
    gateway.host(request('/')),
  );
  assert.equal(
    access.url.hostname,
    'pv-' + runId.replaceAll('-', '') + '-relay',
  );
  await assert.rejects(() =>
    gateway.handle(
      request('/.__mergeron_preview/session', { token }),
      response(),
    ),
  );
  await gateway.close();
});
test('tickets cannot authorize another preview, another origin or revoked access', async () => {
  let allowed = true;
  const gateway = new PreviewGateway({
    domain,
    authorize: async () => {
      if (!allowed) throw Error('revoked');
      return { publicHost: host, expiresAt: Date.now() + 600000 };
    },
  });
  let link = await gateway.mint(grant);
  let token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
    'mergeron-preview',
  );
  await assert.rejects(() =>
    gateway.handle(
      request(
        '/.__mergeron_preview/session',
        { token },
        {
          host: runId + '.' + domain,
          origin: 'https://' + runId + '.' + domain,
        },
      ),
      response(),
    ),
  );
  link = await gateway.mint(grant);
  token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
    'mergeron-preview',
  );
  await assert.rejects(() =>
    gateway.handle(
      request(
        '/.__mergeron_preview/session',
        { token },
        { origin: 'https://attacker.example' },
      ),
      response(),
    ),
  );
  allowed = false;
  await assert.rejects(() =>
    gateway.handle(
      request('/.__mergeron_preview/session', { token }),
      response(),
    ),
  );
  await gateway.close();
});
test('bootstrap is trusted, removes the fragment before loading app code and compiles', async () => {
  const gateway = new PreviewGateway({
      domain,
      authorize: async () => {
        throw Error();
      },
    }),
    res = response();
  gateway.bootstrap(res);
  assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  assert.match(res.body, /history.replaceState/);
  const script = res.body.match(
    /<script nonce="[^"]+">([\s\S]*?)<\/script>/,
  )[1];
  assert.doesNotThrow(() => new Function(script));
  await gateway.close();
});
test('ambient infrastructure cookies and identities never reach project applications', () => {
  assert.equal(
    appCookies(
      'codex_webui_session=platform; authentik_session=private; __Host-mergeron_preview=capability',
      runId,
    ),
    '',
  );
  const wrapped = appSetCookie(
    'session=app; Domain=example.org; Path=/api; HttpOnly; Max-Age=60',
    runId,
  );
  assert.match(wrapped, /^__Host-mergeron_preview_app_/);
  assert.doesNotMatch(wrapped, /Domain=/);
  assert.match(wrapped, /Path=\//);
  assert.equal(
    appCookies(wrapped.split(';')[0] + '; authentik_session=private', runId),
    'session=app',
  );
  const result = clean({
    'x-webui-auth-source': 'authentik',
    'x-mergeron-preview-transport': 'secret',
    authorization: 'Bearer platform',
    cookie: 'all',
    connection: 'x-remove',
    'x-remove': 'smuggled',
    'content-type': 'text/html',
  });
  assert.deepEqual(result, { 'content-type': 'text/html' });
});
test('expired access and cross-origin WebSocket upgrades fail closed', async () => {
  let now = 1000;
  const gateway = new PreviewGateway({
    domain,
    now: () => now,
    authorize: async () => ({ publicHost: host, expiresAt: 100000 }),
  });
  const link = await gateway.mint(grant),
    token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
      'mergeron-preview',
    );
  now = 62000;
  await assert.rejects(() =>
    gateway.handle(
      request('/.__mergeron_preview/session', { token }),
      response(),
    ),
  );
  assert.throws(() =>
    gateway.origin(
      { headers: { origin: 'https://other.' + domain }, method: 'GET' },
      { origin: 'https://' + host },
      true,
    ),
  );
  await gateway.close();
});

test('a recreated run keeps its URL but cannot inherit old tickets, gateway sessions or app cookies', async () => {
  const nextRun = '33333333-3333-4333-8333-333333333333';
  let current = runId;
  const gateway = new PreviewGateway({
    domain,
    authorize: async (g) => {
      if (g.runId !== current) throw Error('revoked');
      return {
        publicHost: host,
        endpoint: 'http://pv-' + current.replaceAll('-', '') + '-relay:8180',
        token: 'a'.repeat(64),
        expiresAt: Date.now() + 600000,
      };
    },
  });
  async function exchange(link) {
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
      'mergeron-preview',
    );
    const res = response();
    await gateway.handle(
      request('/.__mergeron_preview/session', { token }),
      res,
    );
    return res.headers['set-cookie'].split(';')[0];
  }
  const first = await gateway.mint(grant);
  const oldCookie = await exchange(first);
  const oldTicket = await gateway.mint(grant);
  current = nextRun;
  await assert.rejects(() =>
    gateway.access(
      request('/', {}, { cookie: oldCookie }),
      gateway.host(request('/')),
    ),
  );
  await assert.rejects(() => exchange(oldTicket));
  const next = await gateway.mint({ ...grant, runId: nextRun });
  assert.equal(new URL(next.url).origin, new URL(first.url).origin);
  const newCookie = await exchange(next);
  const access = await gateway.access(
    request('/', {}, { cookie: newCookie }),
    gateway.host(request('/')),
  );
  assert.equal(
    access.url.hostname,
    'pv-' + nextRun.replaceAll('-', '') + '-relay',
  );
  const previousAppCookie = appSetCookie('session=old', runId).split(';')[0];
  assert.equal(appCookies(previousAppCookie, nextRun), '');
  const currentAppCookie = appSetCookie('session=new', nextRun).split(';')[0];
  assert.equal(
    appCookies(previousAppCookie + '; ' + currentAppCookie, nextRun),
    'session=new',
  );
  assert.equal(appCookies(currentAppCookie, undefined), '');
  await gateway.close();
});

test('already running legacy run-host previews remain accessible until they stop', async () => {
  const legacy = runId + '.' + domain;
  const gateway = new PreviewGateway({
    domain,
    authorize: async () => ({
      publicHost: legacy,
      endpoint: 'http://pv-' + runId.replaceAll('-', '') + '-relay:8180',
      token: 'a'.repeat(64),
      expiresAt: Date.now() + 600000,
    }),
  });
  const link = await gateway.mint(grant);
  assert.equal(new URL(link.url).host, legacy);
  const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
    'mergeron-preview',
  );
  const res = response();
  const headers = { host: legacy, origin: 'https://' + legacy };
  await gateway.handle(
    request('/.__mergeron_preview/session', { token }, headers),
    res,
  );
  const req = request(
    '/',
    {},
    { ...headers, cookie: res.headers['set-cookie'].split(';')[0] },
  );
  assert.ok(await gateway.access(req, gateway.host(req)));
  await gateway.close();
});

test('a grant cannot mint a foreign host and service workers cannot persist on stable origins', async () => {
  const gateway = new PreviewGateway({
    domain,
    authorize: async () => ({
      publicHost: 'attacker.example',
      expiresAt: Date.now() + 600000,
    }),
  });
  await assert.rejects(() => gateway.mint(grant), /PREVIEW_IDENTITY_CHANGED/);
  const res = response();
  const req = request('/sw.js', {}, { 'service-worker': 'script' });
  req.method = 'GET';
  await gateway.handle(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(
    gateway.responseHeaders({ 'service-worker-allowed': '/' }, runId)[
      'service-worker-allowed'
    ],
    undefined,
  );
  await gateway.close();
});
