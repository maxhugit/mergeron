'use strict';
/** Dedicated-origin HTTP/WS gateway. Never mount this on Mergeron's origin. */
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const COOKIE = '__Host-mergeron_preview';
const APP_COOKIE = '__Host-mergeron_preview_app_';
const SESSION_PATH = '/.__mergeron_preview/session';
const digest = (v) => createHash('sha256').update(v).digest('hex');
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
function clean(input) {
  const connection = String(input.connection ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(input).filter(
      ([k]) =>
        !hop.has(k) &&
        !connection.includes(k) &&
        !/^x-(?:webui|mergeron|forwarded)-/.test(k) &&
        !['authorization', 'cookie', 'set-cookie'].includes(k),
    ),
  );
}
function cookieMap(header) {
  const map = new Map();
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const name = part.slice(0, i).trim();
      if (map.has(name)) map.set(name, '');
      else map.set(name, part.slice(i + 1).trim());
    }
  }
  return map;
}
function appCookies(header) {
  const values = [];
  for (const [name, value] of cookieMap(header)) {
    if (!name.startsWith(APP_COOKIE)) continue;
    const encoded = name.slice(APP_COOKIE.length);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(decoded) ||
      Buffer.from(decoded).toString('base64url') !== encoded
    )
      continue;
    values.push(decoded + '=' + value);
  }
  return values.join('; ');
}
function appSetCookie(value) {
  const parts = value.split(';'),
    first = parts.shift(),
    index = first.indexOf('=');
  if (index < 1) return null;
  const name = first.slice(0, index).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) return null;
  // The namespace prevents forwarding any ambient parent-domain cookie to a
  // project's server. App HttpOnly cookie sessions retain their original names
  // upstream; direct document.cookie access intentionally cannot read them.
  const retained = parts
    .map((v) => v.trim())
    .filter((v) => /^(?:Max-Age|Expires|HttpOnly)(?:=|$)/i.test(v));
  return (
    APP_COOKIE +
    Buffer.from(name).toString('base64url') +
    first.slice(index) +
    '; Path=/; Secure; SameSite=Strict' +
    (retained.length ? '; ' + retained.join('; ') : '')
  );
}
class PreviewGateway {
  constructor({ domain, authorize, now = Date.now }) {
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    )
      throw Error('PREVIEW_INVALID_DOMAIN');
    this.domain = domain;
    this.authorize = authorize;
    this.now = now;
    this.tickets = new Map();
    this.sessions = new Map();
    this.sockets = new Set();
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(() => this.error(res, 403));
    });
    this.server.on('upgrade', (req, socket, head) => {
      void this.upgrade(req, socket, head).catch(() =>
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'),
      );
    });
    this.server.on('connect', (_, socket) =>
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'),
    );
    this.server.maxConnections = 256;
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 120000;
  }
  host(req) {
    const host = req.headers.host;
    if (
      typeof host !== 'string' ||
      host !== host.toLowerCase() ||
      !host.endsWith('.' + this.domain)
    )
      throw Error();
    const id = host.slice(0, -this.domain.length - 1);
    if (!uuid.test(id)) throw Error();
    return { host, id, origin: 'https://' + host };
  }
  prune() {
    for (const map of [this.tickets, this.sessions])
      for (const [key, v] of map)
        if (v.expiresAt <= this.now()) map.delete(key);
  }
  async mint(grant, path = '/') {
    this.prune();
    if (
      !uuid.test(grant.previewId) ||
      !uuid.test(grant.runId) ||
      !grant.identity?.personId ||
      grant.identity.impersonation ||
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\r\n#\\]/.test(path)
    )
      throw Error('PREVIEW_ACCESS_DENIED');
    const verified = await this.authorize(grant);
    if (this.tickets.size >= 1000 || this.sessions.size >= 2000)
      throw Error('PREVIEW_SESSION_LIMIT');
    const token = randomBytes(32).toString('base64url');
    this.tickets.set(digest(token), {
      ...grant,
      expiresAt: Math.min(this.now() + 60000, verified.expiresAt),
    });
    return {
      url: `https://${grant.runId}.${this.domain}/.__mergeron_preview/open#mergeron-preview=${token}&path=${encodeURIComponent(path)}`,
      expiresAt: this.now() + 60000,
    };
  }
  error(
    res,
    status = 403,
    text = 'Preview access unavailable. Open the preview from Mergeron.',
  ) {
    if (!res.headersSent)
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    res.end(text);
  }
  origin(req, target, upgrade = false) {
    if (req.headers.origin && req.headers.origin !== target.origin)
      throw Error();
    const site = req.headers['sec-fetch-site'];
    if (
      site &&
      !['same-origin', 'none'].includes(site) &&
      !(
        req.method === 'GET' &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document'
      )
    )
      throw Error();
    if (upgrade && req.headers.origin !== target.origin) throw Error();
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      req.headers.origin !== target.origin
    )
      throw Error();
  }
  bootstrap(res) {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'x-content-type-options': 'nosniff',
    });
    res.end(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Aperçu Mergeron</title><p id="status">Ouvrez cet aperçu depuis Mergeron pour autoriser l’accès.</p><script nonce="${nonce}">
      const params = new URLSearchParams(location.hash.slice(1));
      const token = params.get('mergeron-preview');
      const path = params.get('path') || '/';
      const safe = path.startsWith('/') && !path.startsWith('//') && !/[\\\\\\r\\n#]/.test(path);
      history.replaceState(null, '', safe ? path : '/');
      if(token) fetch('${SESSION_PATH}', {method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({token})})
        .then(r => {if(!r.ok) throw Error(); location.reload();}).catch(() => {document.getElementById('status').textContent = 'Autorisation expirée. Rouvrez l’aperçu depuis Mergeron.';});
      </script></html>`);
  }
  async exchange(req, res, target) {
    this.origin(req, target);
    let bytes = 0,
      body = '';
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 1024) throw Error();
      body += chunk.toString();
    }
    const token = JSON.parse(body).token;
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token))
      throw Error();
    const key = digest(token),
      grant = this.tickets.get(key);
    this.tickets.delete(key);
    if (!grant || grant.runId !== target.id || grant.expiresAt <= this.now())
      throw Error();
    const transport = await this.authorize(grant);
    const session = randomBytes(32).toString('base64url'),
      expiresAt = Math.min(this.now() + 30 * 60000, transport.expiresAt);
    this.sessions.set(digest(session), { ...grant, expiresAt });
    res.writeHead(204, {
      'set-cookie': `${COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - this.now()) / 1000))}`,
      'cache-control': 'no-store',
    });
    res.end();
  }
  async access(req, target) {
    this.origin(req, target);
    this.prune();
    const token = cookieMap(req.headers.cookie).get(COOKIE);
    const grant = token && this.sessions.get(digest(token));
    if (!grant || grant.runId !== target.id || grant.expiresAt <= this.now())
      return null;
    const transport = await this.authorize(grant);
    const url = new URL(transport.endpoint);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== `pv-${target.id.replaceAll('-', '')}-relay` ||
      url.port !== '8180' ||
      !/^[a-f0-9]{64}$/.test(transport.token) ||
      transport.publicHost !== target.host
    )
      throw Error();
    return { grant, transport, url };
  }
  headers(req, target, access, upgrade = false) {
    const h = {
      ...clean(req.headers),
      host: target.host,
      'x-mergeron-preview-transport': access.transport.token,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': target.host,
    };
    const cookies = appCookies(req.headers.cookie);
    if (cookies) h.cookie = cookies;
    if (upgrade) {
      h.connection = 'Upgrade';
      h.upgrade = 'websocket';
    }
    return h;
  }
  responseHeaders(headers) {
    const h = clean(headers);
    h['cache-control'] = 'no-store';
    h['referrer-policy'] = 'no-referrer';
    h['x-content-type-options'] = 'nosniff';
    // A preview cannot mint parent-domain cookies or capture the gateway cookie.
    if (headers['set-cookie'])
      h['set-cookie'] = headers['set-cookie'].map(appSetCookie).filter(Boolean);
    return h;
  }
  async handle(req, res) {
    const target = this.host(req);
    if (!req.url.startsWith('/') || req.url.startsWith('//')) throw Error();
    if (req.url === '/.__mergeron_preview/open' && req.method === 'GET')
      return this.bootstrap(res);
    if (req.url === SESSION_PATH && req.method === 'POST')
      return this.exchange(req, res, target);
    if (req.url.startsWith('/.__mergeron_preview/'))
      return this.error(res, 404);
    const access = await this.access(req, target);
    if (!access) {
      if (req.method === 'GET') return this.bootstrap(res);
      return this.error(res, 401);
    }
    const upstream = http.request(
      {
        hostname: access.url.hostname,
        port: access.url.port,
        path: req.url,
        method: req.method,
        headers: this.headers(req, target, access),
        timeout: 30000,
      },
      (reply) => {
        res.writeHead(
          reply.statusCode ?? 502,
          this.responseHeaders(reply.headers),
        );
        reply.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () =>
      this.error(
        res,
        502,
        'The preview application is starting or unavailable.',
      ),
    );
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  async upgrade(req, client, head) {
    const target = this.host(req);
    this.origin(req, target, true);
    if (
      !req.url.startsWith('/') ||
      req.url.startsWith('//') ||
      req.url.startsWith('/.__mergeron_preview/') ||
      req.headers.upgrade?.toLowerCase() !== 'websocket'
    )
      throw Error();
    const access = await this.access(req, target);
    if (!access) throw Error();
    const upstream = http.request({
      hostname: access.url.hostname,
      port: access.url.port,
      path: req.url,
      headers: this.headers(req, target, access, true),
      timeout: 10000,
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('response', () =>
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'),
    );
    upstream.on('error', () => client.destroy());
    upstream.on('upgrade', (reply, socket, pending) => {
      if (reply.statusCode !== 101) {
        socket.destroy();
        client.destroy();
        return;
      }
      const h = this.responseHeaders(reply.headers);
      h.connection = 'Upgrade';
      h.upgrade = 'websocket';
      client.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(h)
            .flatMap(([k, v]) =>
              (Array.isArray(v) ? v : [v]).map((value) => `${k}: ${value}\r\n`),
            )
            .join('') +
          '\r\n',
      );
      if (head.length) socket.write(head);
      if (pending.length) client.write(pending);
      socket.pipe(client);
      client.pipe(socket);
      this.sockets.add(client);
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void this.access(req, target)
          .then((v) => {
            if (!v) client.destroy();
          })
          .catch(() => client.destroy())
          .finally(() => {
            checking = false;
          });
      }, 5000);
      timer.unref();
      client.on('close', () => {
        clearInterval(timer);
        socket.destroy();
        this.sockets.delete(client);
      });
      socket.on('close', () => client.destroy());
      client.on('error', () => socket.destroy());
      socket.on('error', () => client.destroy());
    });
    upstream.end();
  }
  async close() {
    for (const s of this.sockets) s.destroy();
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise((resolve) => this.server.close(resolve));
  }
}
module.exports = { PreviewGateway, appCookies, appSetCookie, clean };
