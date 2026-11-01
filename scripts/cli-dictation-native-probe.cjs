/** CI only, inside the existing network-none CLI fixture. No account/inference.
 * Real compiled Mergeron service + real installed CLI, loopback HTTP sentinel.
 * Rejected calls check native preflight; a synthetic sideband checks parsing.
 * No account entitlement, real SDP acceptance or working media is asserted. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createInterface } = require('node:readline');
const { createHash } = require('node:crypto');
const appRoot = process.env.MERGERON_PROBE_APP_ROOT || '/app';
const { CodexAudioService } = require(
  join(appRoot, 'dist/simple-chat/codex-audio.service'),
);
const { CatalogAdmissionService } = require(
  join(appRoot, 'dist/codex/catalog/catalog-admission.service'),
);

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
  let syntheticSideband = false;
  let guardedTurn;
  let guardedTurnInterrupted = false;
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (
        syntheticSideband === 'handoff' &&
        request.method === 'POST' &&
        url.pathname === '/backend-api/codex/responses'
      ) {
        // A held synthetic response, cancelled by the real turn/interrupt. No tools.
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"offline_held","status":"in_progress"}}\n\n',
        );
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/backend-api/codex/models'
      ) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"models":[]}');
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(url.pathname, '/backend-api/codex/realtime/calls');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length <= 65536, 'Sentinel body exceeded limit');
      }
      const payload = JSON.parse(body);
      assert.equal(payload.sdp, offer, 'Native CLI did not forward the offer');
      assert.equal(typeof payload.session, 'object');
      const alpha = request.headers['openai-alpha'];
      assert.ok(['quicksilver=v1', 'quicksilver=v2'].includes(alpha));
      calls.push(alpha);
      if (alpha !== 'quicksilver=v2') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          '{"error":{"message":"AVAS requires OpenAI-Alpha: quicksilver=v2.","code":"invalid_quicksilver_alpha_header","type":"invalid_request_error"}}',
        );
        return;
      }
      if (syntheticSideband) {
        response.writeHead(201, {
          'Content-Type': 'application/sdp',
          Location: '/backend-api/codex/realtime/calls/rtc_offline_voice',
        });
        response.end('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
        return;
      }
    } catch (error) {
      faults.push(
        error instanceof assert.AssertionError
          ? 'unexpected-loopback-request:' + error.operator
          : 'unexpected-loopback-request',
      );
    }
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(
      '{"error":{"message":"Offline fixture refuses media calls","type":"invalid_request_error"}}',
    );
  });
  // A minimal loopback-only RFC6455 fixture; no packages or external endpoint.
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => faults.push('sideband-socket-error'));
    try {
      assert.ok(syntheticSideband);
      assert.equal(
        new URL(request.url, 'http://localhost').pathname,
        '/backend-api/codex/rtc_offline_voice',
      );
      assert.equal(request.headers['openai-alpha'], 'quicksilver=v2');
      const accept = createHash('sha1')
        .update(
          request.headers['sec-websocket-key'] +
            '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
        )
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n',
      );
      const send = (value) => {
        const data = Buffer.from(JSON.stringify(value));
        assert.ok(data.length < 4096);
        const header =
          data.length < 126
            ? Buffer.from([0x81, data.length])
            : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
        socket.write(Buffer.concat([header, data]));
      };
      socket.on('data', (chunk) => {
        if ((chunk[0] & 0x0f) === 8) socket.end(Buffer.from([0x88, 0]));
      });
      send({ type: 'session.started', session: { id: 'offline_voice' } });
      send({
        type: 'output_transcript.added',
        item: { text: 'IGNORE ASSISTANT' },
      });
      for (const text of ['Bonjour,', ' oui', ' oui.'])
        send({ type: 'input_transcript.added', item: { text } });
      if (syntheticSideband === 'handoff')
        send({
          type: 'delegation.created',
          item: {
            id: 'offline_delegation',
            type: 'delegation',
            target: 'client',
            content: [{ type: 'input_text', text: 'NOT A USER TRANSCRIPT' }],
          },
        });
      // Deliberately no turn.done: this reproduces the observed DEV sequence.
    } catch {
      faults.push('sideband-fixture-failed');
      socket.destroy();
    }
  });
  const deadline = setTimeout(() => {
    child?.kill('SIGKILL');
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
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
experimental_realtime_ws_base_url = "http://127.0.0.1:${port}/backend-api/codex"
experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:${port}/backend-api/codex"
[model_providers.offline_voice_fixture]
name = "Offline voice fixture"
base_url = "http://127.0.0.1:${port}/backend-api/codex"
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
    let emulateOldRequest;
    wire = new EventEmitter();
    wire.request = async (method, params) => {
      // Only the account check is stubbed; never read real auth.json or log in.
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (emulateOldRequest && method === 'thread/realtime/start') {
        params = { ...params };
        delete params.version;
        if (emulateOldRequest === 'text') params.outputModality = 'text';
      }
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
      } else if (message.method) {
        if (syntheticSideband === 'handoff') {
          if (message.method === 'turn/started')
            guardedTurn = message.params.turn.id;
          if (
            message.method === 'turn/completed' &&
            message.params.turn.id === guardedTurn
          )
            guardedTurnInterrupted =
              message.params.turn.status === 'interrupted';
        }
        wire.emit('notification', message);
      }
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
    emulateOldRequest = 'text';
    await assert.rejects(
      service.start(offer),
      /configuration vocale est incompatible/,
    );
    assert.equal(calls.length, 0, 'Old invalid mode must fail before HTTP');
    assert.equal(admission.pending().length, 0);
    phase = 'old-default-protocol';
    emulateOldRequest = 'default';
    await assert.rejects(
      service.start(offer),
      /configuration vocale est incompatible/,
    );
    assert.deepEqual(calls, ['quicksilver=v1']);
    assert.equal(admission.pending().length, 0);
    emulateOldRequest = undefined;
    phase = 'corrected-audio';
    await assert.rejects(service.start(offer), /erreur technique/);
    assert.equal(
      calls.length,
      2,
      'Corrected mode must pass native preflight and reach the sentinel',
    );
    assert.deepEqual(calls, ['quicksilver=v1', 'quicksilver=v2']);
    phase = 'synthetic-frameless-transcript';
    syntheticSideband = true;
    const opened = await service.start(offer);
    const transcript = await service.finish(opened.id);
    assert.equal(transcript.text, 'Bonjour, oui oui.');
    phase = 'synthetic-guarded-handoff';
    syntheticSideband = 'handoff';
    const guarded = await service.start(offer);
    const safeTranscript = await service.finish(guarded.id);
    assert.equal(safeTranscript.text, 'Bonjour, oui oui.');
    assert.ok(guardedTurn);
    assert.equal(guardedTurnInterrupted, true);
    assert.deepEqual(faults, []);
    assert.equal(admission.pending().length, 0);
    assert.equal(wire.listenerCount('notification'), 0);
    console.log(
      'Native CLI dictation: v3 sideband parses user fragments without turn.done; assistant/delegation text excluded; real unwanted turn confirmed interrupted. No account or media call used.',
    );
  } catch (error) {
    console.error(JSON.stringify({ phase, calls, faults }));
    throw error;
  } finally {
    clearTimeout(deadline);
    await service?.onModuleDestroy();
    child?.kill('SIGKILL');
    await childDone;
    for (const socket of sockets) socket.destroy();
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
