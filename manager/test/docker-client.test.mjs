import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { DockerClient } from '../src/docker-client.mjs';

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
