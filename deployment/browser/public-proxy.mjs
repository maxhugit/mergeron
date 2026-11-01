import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';

const denied = new net.BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  denied.addSubnet(ip, prefix);
export function publicAddress(ip) {
  return net.isIPv4(ip) && !denied.check(ip);
}
export async function resolvePublic(host, resolver = lookup) {
  const addresses = await resolver(host, { all: true, family: 4 });
  if (
    !addresses.length ||
    addresses.some((item) => !publicAddress(item.address))
  )
    throw new Error('Non-public destination');
  return addresses[0].address;
}

/** A dead upstream must never leave a CONNECT client waiting indefinitely. */
export function relayTunnel(socket, upstream, head) {
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.setTimeout(60_000);
  upstream.on('timeout', close);
  upstream.on('error', close);
  upstream.on('close', () => {
    // A normal EOF must flush buffered response bytes, not truncate a download.
    if (upstream.readableEnded) socket.end();
    else close();
  });
  socket.on('error', close);
  socket.on('close', close);
  upstream.once('connect', () => {
    if (socket.destroyed || upstream.destroyed) return close();
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  // The client may disappear while the DNS lookup was pending.
  if (socket.destroyed) close();
}

/** Every TCP connection uses the validated address, with no second DNS lookup. */
export function publicProxy({ allowedDomains } = {}) {
  const allowed = (host) =>
    !allowedDomains ||
    allowedDomains.some(
      (domain) => host === domain || host.endsWith('.' + domain),
    );
  const proxy = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url);
      if (!allowed(url.hostname)) throw new Error('Destination blocked');
      if (
        url.protocol !== 'http:' ||
        (url.port && url.port !== '80') ||
        url.username ||
        url.password
      )
        throw new Error('Unsupported destination');
      const address = await resolvePublic(url.hostname);
      const headers = { ...request.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = http.request(
        {
          host: address,
          port: 80,
          path: url.pathname + url.search,
          method: request.method,
          headers,
          timeout: 20_000,
        },
        (result) => {
          response.writeHead(result.statusCode || 502, result.headers);
          result.pipe(response);
        },
      );
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        response.writeHead(502);
        response.end();
      });
      request.on('aborted', () => upstream.destroy());
      request.pipe(upstream);
    })().catch(() => {
      response.writeHead(403);
      response.end('Destination blocked');
    });
  });
  proxy.on('connect', (request, socket, head) => {
    void (async () => {
      const url = new URL('https://' + request.url);
      if (!allowed(url.hostname)) throw new Error('Destination blocked');
      if (
        (url.port && url.port !== '443') ||
        url.username ||
        url.password ||
        url.pathname !== '/'
      )
        throw new Error('Unsupported tunnel');
      const address = await resolvePublic(url.hostname);
      const upstream = net.connect(443, address);
      relayTunnel(socket, upstream, head);
    })().catch(() => {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
  });
  proxy.headersTimeout = 10_000;
  proxy.requestTimeout = 30_000;
  proxy.maxConnections = 128;
  return proxy;
}
