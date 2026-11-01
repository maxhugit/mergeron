import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import net from 'node:net';
import { publicAddress, resolvePublic, relayTunnel } from './public-proxy.mjs';

class Socket extends EventEmitter {
  destroyed = false;
  writes = [];
  pipes = [];
  setTimeout(ms) {
    this.timeout = ms;
  }
  write(value) {
    this.writes.push(value);
  }
  end() {
    this.ended = true;
  }
  pipe(target) {
    this.pipes.push(target);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

test(
  'a real CONNECT client observes disconnection after upstream idle timeout',
  { timeout: 3000 },
  async (t) => {
    const sockets = new Set();
    const remote = net.createServer((socket) => sockets.add(socket));
    let outgoing;
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      outgoing = net.connect(remote.address().port, '127.0.0.1');
      sockets.add(outgoing);
      relayTunnel(socket, outgoing, Buffer.alloc(0));
    });
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      proxy.close();
      remote.close();
    });
    remote.listen(0, '127.0.0.1');
    await once(remote, 'listening');
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const client = net.connect(proxy.address().port, '127.0.0.1');
    sockets.add(client);
    const [handshake] = await once(client, 'data');
    assert.match(handshake.toString(), /200 Connection Established/);
    const closed = once(client, 'close');
    outgoing.emit('timeout');
    await closed;
    assert.equal(outgoing.destroyed, true);
  },
);

for (const side of ['upstream', 'client']) {
  for (const event of side === 'upstream'
    ? ['timeout', 'error', 'close']
    : ['error', 'close']) {
    test(`CONNECT ${side} ${event} closes both ends, including before handshake`, () => {
      for (const connected of [false, true]) {
        const client = new Socket(),
          upstream = new Socket();
        relayTunnel(client, upstream, Buffer.alloc(0));
        if (connected) upstream.emit('connect');
        (side === 'upstream' ? upstream : client).emit(event);
        assert.equal(client.destroyed, true);
        assert.equal(upstream.destroyed, true);
        const count = client.writes.length;
        upstream.emit('connect');
        assert.equal(client.writes.length, count);
      }
    });
  }
}
test('CONNECT forwards the handshake/head and leaves healthy tunnels open', () => {
  const client = new Socket(),
    upstream = new Socket();
  const head = Buffer.from('initial TLS bytes');
  relayTunnel(client, upstream, head);
  assert.equal(upstream.timeout, 60_000);
  upstream.emit('connect');
  assert.deepEqual(client.writes, [
    'HTTP/1.1 200 Connection Established\r\n\r\n',
  ]);
  assert.deepEqual(upstream.writes, [head]);
  assert.deepEqual(client.pipes, [upstream]);
  assert.deepEqual(upstream.pipes, [client]);
  assert.equal(client.destroyed, false);
  assert.equal(upstream.destroyed, false);
});
test('CONNECT releases the upstream if the client disappeared during DNS resolution', () => {
  const client = new Socket(),
    upstream = new Socket();
  client.destroy();
  relayTunnel(client, upstream, Buffer.alloc(0));
  assert.equal(upstream.destroyed, true);
});
test('CONNECT flushes a normal upstream EOF rather than truncating buffered downloads', () => {
  const client = new Socket(),
    upstream = new Socket();
  relayTunnel(client, upstream, Buffer.alloc(0));
  upstream.readableEnded = true;
  upstream.emit('close');
  assert.equal(client.ended, true);
  assert.equal(client.destroyed, false);
});
test('rejects internal, reserved, multicast and mapped IPv6 addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.20.0.2',
    '192.168.1.1',
    '100.64.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '198.18.0.1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('93.184.216.34'), true);
});
test('rejects mixed public/private DNS and returns a pinned address', async () => {
  await assert.rejects(
    resolvePublic('test', async () => [
      { address: '93.184.216.34' },
      { address: '127.0.0.1' },
    ]),
  );
  assert.equal(
    await resolvePublic('test', async () => [{ address: '93.184.216.34' }]),
    '93.184.216.34',
  );
});
