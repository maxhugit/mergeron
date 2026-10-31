import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeManager } from '../src/health-probe.mjs';

test('a connection which never completes has a whole-request deadline', async () => {
  let destroyed = 0;
  const client = {
    request: () =>
      Object.assign(new EventEmitter(), {
        end() {},
        destroy() {
          destroyed++;
        },
      }),
  };
  assert.deepEqual(
    await probeManager({ socketPath: 'unused', client, deadlineMs: 20 }),
    {
      healthy: false,
      reason: 'managerHealthTimeout',
    },
  );
  assert.equal(destroyed, 1);
});

for (const scenario of [
  'ok',
  '503',
  'redirect',
  'stream',
  'oversized',
  'aborted',
]) {
  test(`real Unix-socket healthcheck: ${scenario}`, async (t) => {
    // Short /tmp path also fits the macOS Unix socket limit.
    const root = await mkdtemp(join(tmpdir(), 'mh-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 's');
    const sockets = new Set();
    let timer;
    const server = http.createServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/healthz');
      response.writeHead(
        scenario === '503' ? 503 : scenario === 'redirect' ? 302 : 200,
      );
      if (scenario === 'stream') {
        response.flushHeaders();
        timer = setInterval(() => response.write('.'), 25);
      } else if (scenario === 'aborted') {
        response.write('partial');
        response.destroy();
      } else response.end(scenario === 'oversized' ? 'x'.repeat(2000) : '{}');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    t.after(() => {
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    await new Promise((resolve) => server.listen(path, resolve));
    const result = await probeManager({ socketPath: path, deadlineMs: 100 });
    assert.equal(result.healthy, scenario === 'ok');
    if (scenario === 'stream')
      assert.equal(result.reason, 'managerHealthTimeout');
    if (scenario === 'ok') {
      const child = spawn(process.execPath, ['manager/src/healthcheck.mjs'], {
        env: { MERGERON_MANAGER_SOCKET: path },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      assert.equal(
        await new Promise((resolve) => child.on('exit', resolve)),
        0,
      );
      assert.equal(output, '');
    }
  });
}

test('missing socket fails without exposing the path or any response', async () => {
  const result = await probeManager({
    socketPath: '/does-not-exist/private.sock',
  });
  assert.deepEqual(result, {
    healthy: false,
    reason: 'managerHealthUnavailable',
  });
});
