/** Explicit disposable Docker integration; never runs in the unit-test glob.
 * The outer harness supplies one NEW empty host directory and a NEW isolated
 * admin network. No production volumes, accounts, agents or ports are used.
 */
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { DockerClient } from '../src/docker-client.mjs';
import { PreviewManager } from '../src/previews.mjs';
import gatewayModule from '../../runtime/preview-gateway.cjs';

const { PreviewGateway } = gatewayModule;
const stack = process.env.MERGERON_PREVIEW_TEST_STACK,
  hostRoot = process.env.MERGERON_PREVIEW_TEST_ROOT,
  image = process.env.MERGERON_PREVIEW_TEST_SDK;
const pythonImage = process.env.MERGERON_PREVIEW_TEST_PYTHON ?? image;
if (
  process.env.MERGERON_PREVIEW_INTEGRATION !== 'true' ||
  !/^mergeron-preview-check-[a-f0-9]{8}$/.test(stack) ||
  !/^\/tmp\/mergeron-preview-check-[A-Za-z0-9]{8}$/.test(hostRoot) ||
  !/^.+@sha256:[a-f0-9]{64}$/.test(pythonImage) ||
  !/^.+@sha256:[a-f0-9]{64}$/.test(image)
)
  throw Error('Explicit isolated fixture configuration required');
const docker = new DockerClient(),
  admin = stack + '-admin',
  self = process.env.HOSTNAME;
// Fixture-only diagnostics: method/path, never environment values or tokens.
const dockerRequest = docker.request.bind(docker);
docker.request = async (endpoint, options) => {
  console.log(
    'Fixture Docker:',
    options?.method ?? 'GET',
    endpoint.split('?')[0],
  );
  return dockerRequest(endpoint, options);
};
const network = await docker.inspectNetwork(admin);
assert.equal(network.Internal, true);
assert.equal(
  network.Options['com.docker.network.bridge.gateway_mode_ipv4'],
  'isolated',
);
assert.equal(network.Labels?.['io.mergeron.preview-test'], stack);
const actual = await docker.inspectContainer(self);
const controllerIp = actual.NetworkSettings.Networks[admin].IPAddress;
const labels = {
  'io.mergeron.preview-test': stack,
  'io.mergeron.stack': stack,
};
const manifest = {
  stack,
  components: [{ id: 'application', canonicalName: stack + '-ui' }],
  networks: [{ id: 'admin', name: admin }],
};
const configuration = {
  stateRoot: hostRoot,
  hostStatePath: '/host-test',
  previewJournal: '/host-test/journal',
  publicUrl: 'https://mergeron.example.test',
};
const env = {
  MERGERON_PREVIEWS_ENABLED: 'true',
  MERGERON_PREVIEW_DOMAIN: 'preview.example.test',
  MERGERON_PREVIEW_IMAGES: JSON.stringify({
    node: { image },
    python: { image: pythonImage },
  }),
};
const manager = new PreviewManager({
  docker,
  manifest,
  configuration,
  env,
  self,
});
await manager.ready;
let dummy, gateway;
const results = [];
function archive(files) {
  const buffers = [];
  for (const [name, source] of Object.entries(files)) {
    const data = Buffer.from(source),
      h = Buffer.alloc(512),
      put = (s, p, n) => h.write(s, p, n, 'ascii'),
      oct = (v, n) => v.toString(8).padStart(n - 1, '0') + '\0';
    assert.ok(name.length < 100);
    put(name, 0, 100);
    put(oct(0o600, 8), 100, 8);
    put(oct(11002, 8), 108, 8);
    put(oct(11002, 8), 116, 8);
    put(oct(data.length, 12), 124, 12);
    put(oct(0, 12), 136, 12);
    put('        ', 148, 8);
    put('0', 156, 1);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put(
      [...h]
        .reduce((s, v) => s + v, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      8,
    );
    buffers.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...buffers, Buffer.alloc(1024)]);
}
function snapshot(projectId, files, snapshotId = randomUUID()) {
  const data = archive(files),
    target =
      '/host-test/workspace/.mergeron-system/' +
      projectId +
      '/previews/' +
      snapshotId;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(target + '/source.tar', data, { mode: 0o600 });
  return {
    snapshotId,
    sourceSha: createHash('sha256').update(data).digest('hex'),
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function request(url, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method, timeout: 5000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (s) => {
        text += s;
        if (text.length > 65536) req.destroy(Error('response limit'));
      });
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, text }),
      );
    });
    req.on('timeout', () => req.destroy(Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
async function ready(url, options, expected) {
  let last;
  for (let n = 0; n < 30; n++) {
    try {
      last = await request(url, options);
      if (last.status === 200 && last.text.includes(expected)) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(200);
  }
  throw Error('Application not ready: ' + JSON.stringify(last));
}
function websocket(url, headers) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const req = http.request(url, {
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
      timeout: 5000,
    });
    req.on('upgrade', (res, socket) => {
      assert.equal(res.statusCode, 101);
      assert.equal(
        res.headers['sec-websocket-accept'],
        createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64'),
      );
      socket.destroy();
      resolve();
    });
    req.on('response', (res) => {
      res.resume();
      reject(Error('WS ' + res.statusCode));
    });
    req.on('timeout', () => req.destroy(Error('WS timeout')));
    req.on('error', reject);
    req.end();
  });
}
const server = `const http=require('node:http'),fs=require('node:fs'),crypto=require('node:crypto');
const s=http.createServer(async(req,res)=>{if(req.url==='/probe-private'){let reachable=false;try{await fetch('http://${controllerIp}:8173/',{signal:AbortSignal.timeout(1000)});reachable=true;}catch{}res.end(JSON.stringify({reachable}));return;}if(req.url==='/plant-link'){fs.mkdirSync('/tmp/isolated-target',{recursive:true});fs.writeFileSync('/tmp/isolated-target/file.txt','keep');fs.symlinkSync('/tmp/isolated-target','nested');res.end('planted');return;}if(req.url==='/verify-link'){res.end(fs.readFileSync('/tmp/isolated-target/file.txt'));return;}res.setHeader('content-type','text/html');res.setHeader('x-test-cookie',req.headers.cookie||'');res.setHeader('x-test-auth',req.headers.authorization||'');res.end(fs.readFileSync('index.html'));});
s.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');});s.listen(Number(process.env.PORT),'0.0.0.0');`;
try {
  dummy = (
    await docker.createContainer(stack + '-ui', {
      Image: actual.Image,
      Entrypoint: ['/nodejs/bin/node'],
      Cmd: ['-e', 'setInterval(()=>{},60000)'],
      User: '11002:11002',
      Labels: {
        ...labels,
        'io.mergeron.managed': 'true',
        'io.mergeron.component': 'application',
      },
      HostConfig: {
        NetworkMode: admin,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 64 * 1024 ** 2,
        Tmpfs: {
          '/run/mergeron-manager': 'ro,nosuid,nodev,size=1m,mode=0000',
          '/var/lib/mergeron-manager': 'ro,nosuid,nodev,size=1m,mode=0000',
        },
        Mounts: [
          {
            Type: 'bind',
            Source: hostRoot + '/workspace',
            Target: '/workspaces',
            ReadOnly: true,
          },
        ],
      },
    })
  ).Id;
  await docker.startContainer(dummy);
  const a = snapshot('node-project', {
      'server.js': server,
      'index.html': '<h1>Uncommitted Node project A</h1>',
    }),
    input = {
      projectId: 'node-project',
      agentId: 'agent-a',
      runId: a.snapshotId,
      previewId: randomUUID(),
      sourceSha: a.sourceSha,
      profile: {
        enabled: true,
        runtime: 'node',
        start: 'node server.js',
        memoryMb: 256,
      },
    };
  console.log('Fixture phase: start Node preview');
  await manager.start(input);
  const transport = await manager.transport(input.runId),
    host = transport.publicHost;
  await ready(
    transport.endpoint,
    { headers: { host, 'x-mergeron-preview-transport': transport.token } },
    'project A',
  );
  results.push('Node HTTP application from current source');
  // The real Manager uses network_mode:none. Trap accidental TCP probes here,
  // while its Docker Unix-socket client remains permitted.
  const originalRequest = http.request;
  let verifiedReady;
  http.request = (options, ...args) => {
    assert.ok(
      options.socketPath,
      'Manager readiness must not open a TCP socket',
    );
    return originalRequest(options, ...args);
  };
  try {
    for (let n = 0; n < 30; n++) {
      verifiedReady = await manager.status(input.runId);
      if (verifiedReady.ready) break;
      await sleep(200);
    }
  } finally {
    http.request = originalRequest;
  }
  assert.equal(verifiedReady.ready, true);
  assert.equal(verifiedReady.httpStatus, 200);
  assert.equal(
    verifiedReady.url,
    'https://' + input.runId + '.preview.example.test/',
  );
  results.push('HTTP readiness verified by Manager before advertising the URL');
  const grant = {
    previewId: input.previewId,
    runId: input.runId,
    projectId: input.projectId,
    threadId: 'agent-a',
    identity: { kind: 'person', personId: 'test-person' },
  };
  let authorized = true;
  gateway = new PreviewGateway({
    domain: 'preview.example.test',
    authorize: async (g) => {
      assert.equal(g.projectId, 'node-project');
      if (!authorized) throw Error('revoked');
      return manager.transport(g.runId);
    },
  });
  await new Promise((resolve) =>
    gateway.server.listen(8173, '0.0.0.0', resolve),
  );
  const minted = await gateway.mint(grant),
    token = new URLSearchParams(new URL(minted.url).hash.slice(1)).get(
      'mergeron-preview',
    );
  const exchanged = await request(
    'http://127.0.0.1:8173/.__mergeron_preview/session',
    {
      method: 'POST',
      headers: {
        host,
        origin: 'https://' + host,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    },
  );
  assert.equal(exchanged.status, 204);
  const cookie = exchanged.headers['set-cookie'][0].split(';')[0];
  const headers = {
    host,
    origin: 'https://' + host,
    cookie:
      cookie +
      '; codex_webui_session=must-not-leak; authentik_session=must-not-leak',
    authorization: 'Bearer must-not-leak',
  };
  const before = await ready(
    'http://127.0.0.1:8173/',
    { headers },
    'project A',
  );
  assert.equal(before.headers['x-test-cookie'], '');
  assert.equal(before.headers['x-test-auth'], '');
  results.push(
    'Direct preview gateway with scoped session; no infrastructure cookies/identity forwarded',
  );
  console.log('Fixture phase: WebSocket');
  await websocket('http://127.0.0.1:8173/hmr', headers);
  results.push('WebSocket upgrade through both gateway and private relay');
  const runtime = manager.records.get(input.runId).runtimeId,
    next = snapshot('node-project', {
      'server.js': server,
      'index.html': '<h1>Updated without commit or restart</h1>',
    });
  console.log('Fixture phase: hot sync');
  await manager.sync({
    runId: input.runId,
    snapshotId: next.snapshotId,
    sourceSha: next.sourceSha,
  });
  assert.equal(manager.records.get(input.runId).runtimeId, runtime);
  await ready('http://127.0.0.1:8173/', { headers }, 'Updated without commit');
  results.push(
    'Source update visible at the same URL without recreating the runtime',
  );
  const privateProbe = await request('http://127.0.0.1:8173/probe-private', {
    headers,
  });
  assert.equal(JSON.parse(privateProbe.text).reachable, false);
  results.push('Runtime cannot reach the separate controller/admin network');
  await request('http://127.0.0.1:8173/plant-link', { headers });
  const malicious = snapshot('node-project', {
    'server.js': server,
    'index.html': '<h1>same</h1>',
    'nested/file.txt': 'must-not-escape',
  });
  await assert.rejects(
    () =>
      manager.sync({
        runId: input.runId,
        snapshotId: malicious.snapshotId,
        sourceSha: malicious.sourceSha,
      }),
    /PREVIEW_SYNC_FAILED/,
  );
  assert.equal(
    (await request('http://127.0.0.1:8173/verify-link', { headers })).text,
    'keep',
  );
  results.push('No-follow synchronization refuses a runtime-planted symlink');
  const b = snapshot('python-project', {
      'index.html': '<h1>Independent Python project B</h1>',
    }),
    second = {
      projectId: 'python-project',
      agentId: 'agent-b',
      runId: b.snapshotId,
      previewId: randomUUID(),
      sourceSha: b.sourceSha,
      profile: {
        enabled: true,
        runtime: 'python',
        start: 'python3 -m http.server 8000 --bind 0.0.0.0',
        port: 8000,
        memoryMb: 128,
      },
    };
  console.log('Fixture phase: independent Python preview');
  await manager.start(second);
  const other = await manager.transport(second.runId);
  await ready(
    other.endpoint,
    {
      headers: {
        host: other.publicHost,
        'x-mergeron-preview-transport': other.token,
      },
    },
    'Python project B',
  );
  results.push('Second independent project/runtime active in parallel');
  const forged = await request('http://127.0.0.1:8173/', {
    headers: {
      ...headers,
      host: other.publicHost,
      origin: 'https://' + other.publicHost,
    },
  });
  assert.ok(!forged.text.includes('Python project B'));
  authorized = false;
  assert.equal(
    (await request('http://127.0.0.1:8173/', { headers })).status,
    403,
  );
  results.push('Cross-preview cookie reuse and revoked access rejected');
  console.log(JSON.stringify({ ok: true, checks: results }, null, 2));
} finally {
  await gateway?.close();
  for (const r of manager.records.values()) await manager.stop(r.runId);
  if (dummy) {
    const c = await docker.inspectContainer(dummy);
    assert.equal(c.Config.Labels['io.mergeron.preview-test'], stack);
    if (c.State.Running) await docker.stopContainer(dummy, 3);
    await docker.removeContainer(dummy);
  }
}
