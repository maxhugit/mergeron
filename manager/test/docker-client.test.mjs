import { spawnSync } from 'node:child_process';
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

test('vendor inspection executes only the fixed version command and returns only its version', async () => {
  const calls = [];
  const client = new DockerClient();
  client.request = async (path, options) => {
    calls.push({ path, options });
    return path.endsWith('/exec')
      ? { Id: 'vendor-inspection' }
      : 'private extra output\nSquid Cache: Version 6.13\n';
  };
  assert.equal(await client.vendorVersion('squid', 'egress'), '6.13');
  assert.deepEqual(calls[0].options.body.Cmd, ['/usr/sbin/squid', '-v']);
  assert.equal(calls[0].options.body.Privileged, false);
  assert.equal(calls[0].options.body.AttachStdin, false);
  assert.equal(calls[1].options.maxResponseBytes, 16384);
  await assert.rejects(
    client.vendorVersion('squid', 'arbitrary'),
    /Unsupported component/,
  );
});

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

test('catalog exec writes credentials only to stdin and decodes split UTF-8 Docker frames', async () => {
  let input = '',
    command;
  const stream = new EventEmitter();
  stream.destroy = () => {};
  stream.write = (value) => {
    input += value;
    const bytes = Buffer.from(
      JSON.stringify({ apps: [{ id: 'x', name: 'été €' }] }) + '\n',
    );
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    for (const payload of [bytes.subarray(0, split), bytes.subarray(split)]) {
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(payload.length, 4);
      stream.emit('data', Buffer.concat([header, payload]));
    }
  };
  const factory = () => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() =>
        req.emit('upgrade', { statusCode: 101 }, stream, Buffer.alloc(0)),
      );
    return req;
  };
  const docker = new DockerClient('/test', factory);
  docker.request = async (_path, options) => {
    command = options.body;
    return { Id: 'exec' };
  };
  const result = await docker.catalogJob('owned', 'fixed worker source', {
    accessToken: 'secret-only-stdin',
    accountId: 'a',
  });
  assert.equal(result.apps[0].name, 'été €');
  assert.ok(input.includes('secret-only-stdin'));
  assert.ok(!JSON.stringify(command).includes('secret-only-stdin'));
  assert.equal(command.Tty, false);
  assert.equal(command.Privileged, false);
});

test('container cleanup never forces removal or deletes volumes', async () => {
  const mock = transport(() => ({ statusCode: 204 }));
  const client = new DockerClient('/test-only/docker.sock', mock.factory);
  await client.removeContainer('exact-helper');
  assert.equal(mock.requests[0].options.method, 'DELETE');
  assert.equal(
    mock.requests[0].options.path,
    '/containers/exact-helper?force=false&v=false',
  );
});

test('preview version probe uses only fixed unprivileged image binaries and whitelisted metadata', async () => {
  const docker = new DockerClient();
  const calls = [];
  docker.request = async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/exec')) return { Id: 'version-probe' };
    if (path.endsWith('/start'))
      return 'MERGERON_RUNTIME:{"node":"22.23.3","npm":"10.9.0","pnpm":"not-a-version-secret","corepack":"0.34.0","secret":"private"}\n';
    return { Running: false, ExitCode: 0 };
  };
  const result = await docker.previewRuntimeVersions('owned-app');
  assert.equal(result.node, '22.23.3');
  assert.equal(result.pnpm, null);
  assert.equal(result.corepack, '0.34.0');
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  const spec = calls[0].options.body;
  assert.equal(spec.User, '11002:11002');
  assert.equal(spec.Privileged, false);
  assert.equal(spec.WorkingDir, '/');
  assert.equal(spec.Tty, true);
  assert.equal(spec.AttachStdin, false);
  assert.deepEqual(spec.Env, [
    'PATH=/usr/local/bin:/usr/bin:/bin:/nodejs/bin',
    'NODE_OPTIONS=',
    'COREPACK_ENABLE_NETWORK=0',
  ]);
  assert.equal(calls[1].options.maxResponseBytes, 4096);
  assert.ok(spec.Cmd[2].includes('fs.readFileSync'));
  assert.ok(!spec.Cmd[2].includes('execFile'));
});

test('the fixed probe command executes without printing inherited secrets or running a package manager', async () => {
  const docker = new DockerClient();
  let command;
  docker.request = async (path, options) => {
    if (path.endsWith('/exec')) {
      command = options.body.Cmd[2];
      return { Id: 'probe' };
    }
    if (path.endsWith('/start')) {
      const quoted = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
      const script = command.replace(
        'for binary in /usr/local/bin/node /usr/bin/node /nodejs/bin/node;',
        'for binary in ' + quoted + ';',
      );
      const result = spawnSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, PRIVATE_CANARY: 'not-for-version-output' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /not-for-version-output/);
      return result.stdout;
    }
    return { Running: false, ExitCode: 0 };
  };
  assert.equal(
    (await docker.previewRuntimeVersions('owned')).node,
    process.versions.node,
  );
});
