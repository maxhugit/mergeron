import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorDigest } from './update-monitor-journal.mjs';
import { monitorPage, monitorScript } from './update-monitor-page.mjs';

const prefix = '/_mergeron-update';
export function createUpdateGateway({
  directory,
  hostname,
  upstream = 'http://mergeron-ingress:8080',
  request = http.request,
  now = Date.now,
}) {
  const destination = new URL(upstream);
  if (
    destination.protocol !== 'http:' ||
    destination.username ||
    destination.password ||
    destination.pathname !== '/'
  )
    throw new Error('Invalid gateway upstream');
  if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Invalid public host');
  const load = async (name) =>
    JSON.parse(await readFile(join(directory, name), 'utf8'));
  const valid = async (token) => {
    if (!/^[a-f0-9]{64}$/.test(token ?? '')) return false;
    try {
      return (await load('access.json')).some(
        (grant) =>
          grant.hash === monitorDigest(token) && grant.expiresAt > now(),
      );
    } catch {
      return false;
    }
  };
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
  };
  function send(response, status, body, type = 'application/json', extra = {}) {
    response.writeHead(status, { ...headers, 'Content-Type': type, ...extra });
    response.end(body);
  }
  const page = (response) =>
    send(response, 200, monitorPage, 'text/html; charset=utf-8');
  const state = async () => {
    try {
      return await load('state.json');
    } catch {
      return { observedAt: new Date(now()).toISOString(), operation: null };
    }
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.host?.split(':')[0] !== hostname)
      return send(res, 421, '{}');
    if (req.url === '/_gateway-health') return send(res, 200, '{}');
    if (req.url === prefix || req.url === prefix + '/')
      return req.method === 'GET' ? page(res) : send(res, 405, '{}');
    if (req.url === prefix + '/monitor.js')
      return send(res, 200, monitorScript, 'text/javascript; charset=utf-8');
    if (req.url === prefix + '/session' && req.method === 'POST') {
      if (req.headers.origin !== `https://${hostname}`)
        return send(res, 403, '{}');
      let token = '';
      try {
        for await (const chunk of req) {
          token += chunk;
          if (token.length > 128) return send(res, 413, '{}');
        }
      } catch {
        return send(res, 400, '{}');
      }
      if (!(await valid(token))) return send(res, 401, '{}');
      return send(res, 200, '{}', 'application/json', {
        'Set-Cookie': `mergeron_update=${token}; Path=${prefix}; Max-Age=21600; Secure; HttpOnly; SameSite=Strict`,
      });
    }
    if (req.url === prefix + '/status') {
      if (req.method !== 'GET') return send(res, 405, '{}');
      const token = req.headers.cookie?.match(
        /(?:^|;\s*)mergeron_update=([a-f0-9]{64})(?:;|$)/,
      )?.[1];
      if (!(await valid(token))) return send(res, 401, '{}');
      return send(res, 200, JSON.stringify(await state()));
    }
    if (req.url?.startsWith(prefix)) return send(res, 404, '{}');
    const snapshot = await state();
    const document =
      req.method === 'GET' && req.headers.accept?.includes('text/html');
    if (snapshot.operation?.status === 'running') {
      if (document) return page(res);
      return send(
        res,
        503,
        JSON.stringify({ error: 'maintenanceInProgress' }),
        'application/json',
        { 'Retry-After': '3' },
      );
    }
    const proxy = request(
      destination,
      {
        method: req.method,
        path: req.url,
        headers: req.headers,
        timeout: 15000,
      },
      (upstreamResponse) => {
        if (document && [502, 503, 504].includes(upstreamResponse.statusCode)) {
          upstreamResponse.resume();
          return page(res);
        }
        res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    proxy.on('timeout', () => proxy.destroy());
    proxy.on('error', () => {
      if (!res.headersSent) {
        if (document) page(res);
        else
          send(
            res,
            503,
            '{"error":"maintenanceReconnecting"}',
            'application/json',
            { 'Retry-After': '3' },
          );
      } else res.destroy();
    });
    req.on('aborted', () => proxy.destroy());
    req.pipe(proxy);
  });
  server.on('upgrade', async (req, socket, head) => {
    if (
      req.headers.host?.split(':')[0] !== hostname ||
      (await state()).operation?.status === 'running'
    )
      return socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
      );
    const remote = net.connect(
      Number(destination.port) || 80,
      destination.hostname,
      () => {
        remote.write(
          `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
            Object.entries(req.headers)
              .map(([key, value]) => `${key}: ${value}`)
              .join('\r\n') +
            '\r\n\r\n',
        );
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
      },
    );
    remote.setTimeout(300000, () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.on('error', () => remote.destroy());
    socket.on('close', () => remote.destroy());
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createUpdateGateway({
    directory: process.env.MERGERON_MONITOR_DIRECTORY ?? '/monitor',
    hostname: process.env.MERGERON_PUBLIC_HOST,
    upstream: process.env.MERGERON_GATEWAY_UPSTREAM,
  });
  server.listen(8080, '0.0.0.0');
}
