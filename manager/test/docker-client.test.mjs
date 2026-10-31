import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { DockerClient } from '../src/docker-client.mjs';
import { PassThrough } from 'node:stream';

function transport(respond) {
  const requests = [];
  const factory = (options, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => request.emit('error', error);
    request.end = (body) => {
      requests.push({ options, body });
      queueMicrotask(() => {
        const response = new EventEmitter();
        const result = respond(options);
        response.statusCode = result.statusCode ?? 200;
        response.setEncoding = () => undefined;
        callback(response);
        if (result.body) response.emit('data', result.body);
        response.emit('end');
      });
    };
    return request;
  };
  return { factory, requests };
}

test('container terminal uses a non-privileged fixed shell, upgraded stream and scoped exec resize', async () => {
  const calls = [];
  const stream = new PassThrough();
  const docker = new DockerClient('/docker.sock', (options) => {
    const req = new EventEmitter();
    req.destroy = (error) => req.emit('error', error);
    req.end = (body) => {
      calls.push({ options, body });
      queueMicrotask(() =>
        req.emit('upgrade', { statusCode: 101 }, stream, Buffer.from('ready')),
      );
    };
    return req;
  });
  docker.request = async (path, options) => {
    calls.push({ path, options });
    return { Id: 'exec-id' };
  };
  const terminal = await docker.openTerminal(
    'owned-container',
    '11002:11002',
    80,
    24,
  );
  assert.deepEqual(calls[0], {
    path: '/containers/owned-container/exec',
    options: {
      method: 'POST',
      body: {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        User: '11002:11002',
        Env: ['TERM=xterm-256color'],
        Cmd: ['/bin/sh'],
        Privileged: false,
      },
    },
  });
  assert.equal(calls[1].options.path, '/exec/exec-id/start');
  assert.equal(calls[1].options.headers.Upgrade, 'tcp');
  assert.deepEqual(JSON.parse(calls[1].body), {
    Detach: false,
    Tty: true,
    ConsoleSize: [24, 80],
  });
  assert.equal(terminal.read().toString(), 'ready');
  await terminal.resize(100, 30);
  assert.equal(calls[2].path, '/exec/exec-id/resize?w=100&h=30');
  terminal.destroy();
});

test('uses only the declared Docker read and create/start endpoints', async () => {
  const fake = transport((options) => ({
    statusCode: options.path.endsWith('/start') ? 204 : 200,
    body: options.path.startsWith('/images/create')
      ? '{"status":"downloaded"}\n'
      : options.path === '/networks/create'
        ? '{"Id":"network-id"}'
        : options.path.startsWith('/containers/create')
          ? '{"Id":"container-id"}'
          : '[]',
  }));
  const docker = new DockerClient('/docker.sock', fake.factory);
  await docker.listNetworks();
  await docker.listImages();
  await docker.pullImage('ghcr.io/maxhugit/mergeron:latest');
  await docker.createNetwork({ Name: 'mergeron-isolated' });
  await docker.createContainer('mergeron-ui', { Image: 'image' });
  await docker.startContainer('container-id');
  assert.deepEqual(
    fake.requests.map(({ options }) => [options.method, options.path]),
    [
      ['GET', '/networks'],
      ['GET', '/images/json?all=0'],
      [
        'POST',
        '/images/create?fromImage=ghcr.io%2Fmaxhugit%2Fmergeron&tag=latest',
      ],
      ['POST', '/networks/create'],
      ['POST', '/containers/create?name=mergeron-ui'],
      ['POST', '/containers/container-id/start'],
    ],
  );
  assert.equal(
    fake.requests.find(({ options }) => options.path === '/networks/create')
      .body,
    '{"Name":"mergeron-isolated"}',
  );
});

test('surfaces an image pull failure from the Docker event stream', async () => {
  const fake = transport(() => ({ body: '{"error":"registry denied"}\n' }));
  await assert.rejects(
    new DockerClient('/docker.sock', fake.factory).pullImage('nginx:stable'),
    /registry denied/,
  );
});

test('ephemeral previews can stop promptly without changing the application default grace period', async () => {
  const fake = transport(() => ({ statusCode: 204 }));
  const docker = new DockerClient('/docker.sock', fake.factory);
  await docker.stopContainer('preview', 3);
  await docker.stopContainer('application');
  assert.deepEqual(
    fake.requests.map((r) => [r.options.path, r.options.timeout]),
    [
      ['/containers/preview/stop?t=3', 13000],
      ['/containers/application/stop?t=60', 70000],
    ],
  );
  assert.throws(() => docker.stopContainer('preview', 0));
});

test('preview waits remain bounded without shortening the managed CLI installation wait', async () => {
  const fake = transport(() => ({ body: '{"StatusCode":0}' }));
  const docker = new DockerClient('/docker.sock', fake.factory);
  await docker.waitContainer('preview', 45000);
  await docker.waitContainer('managed-cli');
  assert.deepEqual(
    fake.requests.map((r) => r.options.timeout),
    [45000, 180000],
  );
});
test('includes Docker diagnostic messages instead of an opaque HTTP failure', async () => {
  const fake = transport(() => ({
    statusCode: 500,
    body: JSON.stringify({ message: 'invalid security option' }),
  }));
  await assert.rejects(
    new DockerClient('/docker.sock', fake.factory).createContainer(
      'mergeron-dev-ui',
      {},
    ),
    /HTTP 500: invalid security option/,
  );
});
