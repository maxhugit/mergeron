/** CI only, inside the existing network-none CLI fixture. No account/inference.
 * Real compiled Mergeron service + real installed CLI, loopback HTTP sentinel.
 * The sentinel deliberately refuses calls: this checks native preflight, NOT
 * account entitlement, SDP acceptance by OpenAI, or a working media connection. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createInterface } = require('node:readline');
const {
  CodexAudioService,
} = require('/app/dist/simple-chat/codex-audio.service');
const {
  CatalogAdmissionService,
} = require('/app/dist/codex/catalog/catalog-admission.service');

const binary = process.argv[2];
assert.ok(binary, 'Installed test CLI is required');
const offer =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
let phase = 'fixture';

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'mergeron-voice-protocol-'));
  const calls = [];
  const faults = [];
  let child;
  let childDone = Promise.resolve();
  let service;
  let wire;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"models":[]}');
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(url.pathname, '/v1/realtime/calls');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length <= 65536, 'Sentinel body exceeded limit');
      }
      assert.ok(body.includes(offer), 'Native CLI did not forward the offer');
      assert.match(body, /name="session"/);
      calls.push(true);
    } catch {
      faults.push('unexpected-loopback-request');
    }
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(
      '{"error":{"message":"Offline fixture refuses media calls","type":"invalid_request_error"}}',
    );
  });
  const deadline = setTimeout(() => {
    child?.kill('SIGKILL');
    server.closeAllConnections();
  }, 25000);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await writeFile(
      join(home, 'config.toml'),
      `
model_provider = "offline_voice_fixture"
model = "gpt-5.4"
web_search = "disabled"
[model_providers.offline_voice_fixture]
name = "Offline voice fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
`,
    );
    child = spawn(binary, ['app-server'], {
      // Intentionally do NOT inherit login, proxy, API keys or application env.
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: home,
        RUST_LOG: 'error',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    childDone = new Promise((resolve) => child.once('close', resolve));
    child.stderr.resume(); // Drain, but never print native errors or session data.
    let nextId = 0;
    const pending = new Map();
    let emulateOldRequest = false;
    wire = new EventEmitter();
    wire.request = async (method, params) => {
      // Only the account check is stubbed; never read real auth.json or log in.
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (emulateOldRequest && method === 'thread/realtime/start')
        params = { ...params, outputModality: 'text' };
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Offline RPC deadline exceeded'));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        faults.push('invalid-rpc');
        return;
      }
      if ('id' in message) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(new Error('Offline native RPC rejected'));
        else request.resolve(message.result);
      } else if (message.method) wire.emit('notification', message);
    });
    const rejectPending = () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Offline CLI exited'));
      }
      pending.clear();
      wire.emit('close');
    };
    child.on('error', rejectPending);
    child.on('exit', rejectPending);
    child.stdin.on('error', rejectPending);
    phase = 'initialize';
    await wire.request('initialize', {
      clientInfo: {
        name: 'mergeron_voice_fixture',
        title: 'Offline voice fixture',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized","params":{}}\n');
    const admission = new CatalogAdmissionService();
    service = new CodexAudioService({ getClient: () => wire }, admission);
    phase = 'old-text-control';
    emulateOldRequest = true;
    await assert.rejects(
      service.start(offer),
      /configuration vocale est incompatible/,
    );
    assert.equal(calls.length, 0, 'Old invalid mode must fail before HTTP');
    assert.equal(admission.pending().length, 0);
    emulateOldRequest = false;
    phase = 'corrected-audio';
    await assert.rejects(service.start(offer), /erreur technique/);
    assert.equal(
      calls.length,
      1,
      'Corrected mode must pass native preflight and reach the sentinel',
    );
    assert.deepEqual(faults, []);
    assert.equal(admission.pending().length, 0);
    assert.equal(wire.listenerCount('notification'), 0);
    console.log(
      'Native CLI dictation preflight: old text mode rejected; corrected service reaches offline sentinel. No account or media call used.',
    );
  } finally {
    clearTimeout(deadline);
    await service?.onModuleDestroy();
    child?.kill('SIGKILL');
    await childDone;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Exact directory created by this probe, never an application data path.
    await rm(home, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error(
    `Offline native CLI dictation preflight failed at ${phase} (no account or audio data logged).`,
  );
  process.exitCode = 1;
});
