/** Fixed-target transport only. No shell, Docker socket, files or user-selected URL. */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
const target = new URL(process.env.MERGERON_PREVIEW_TARGET);
const publicHost = process.env.MERGERON_PREVIEW_PUBLIC_HOST;
if (
  typeof publicHost !== 'string' ||
  !/^[a-f0-9-]{36}\.(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(publicHost)
)
  throw Error('Invalid public host');
if (
  target.protocol !== 'http:' ||
  !/^app$/.test(target.hostname) ||
  !/^\d+$/.test(target.port)
)
  throw Error('Invalid target');
const expected = Buffer.from(
  process.env.MERGERON_PREVIEW_TRANSPORT_TOKEN ?? '',
);
if (expected.length !== 64) throw Error('Missing transport capability');
function authorized(request) {
  const provided = Buffer.from(
    request.headers['x-mergeron-preview-transport'] ?? '',
  );
  return (
    request.headers.host === publicHost &&
    request.url.startsWith('/') &&
    !request.url.startsWith('//') &&
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}
function headers(input) {
  const value = { ...input, host: publicHost };
  for (const key of [
    'x-mergeron-preview-transport',
    'connection',
    'proxy-authorization',
    'proxy-connection',
  ])
    delete value[key];
  return value;
}
const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: headers(req.headers),
      timeout: 30_000,
    },
    (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Preview application is not ready');
  });
  upstream.on('timeout', () => upstream.destroy());
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});
server.on('connect', (_, socket) =>
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'),
);
server.on('upgrade', (req, client, head) => {
  if (
    !authorized(req) ||
    req.headers.origin !== 'https://' + publicHost ||
    req.headers.upgrade?.toLowerCase() !== 'websocket'
  ) {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = http.request({
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    headers: {
      ...headers(req.headers),
      connection: 'Upgrade',
      upgrade: req.headers.upgrade,
    },
    timeout: 10000,
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('response', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  upstream.on('upgrade', (res, socket, pending) => {
    client.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        Object.entries(res.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n',
    );
    if (head.length) socket.write(head);
    if (pending.length) client.write(pending);
    socket.pipe(client);
    client.pipe(socket);
    client.on('error', () => socket.destroy());
    socket.on('error', () => client.destroy());
    socket.on('close', () => client.destroy());
    client.on('close', () => socket.destroy());
  });
  upstream.on('error', () => client.destroy());
  upstream.end();
});
server.maxConnections = 128;
server.requestTimeout = 60_000;
server.headersTimeout = 10_000;
server.listen(8180, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
