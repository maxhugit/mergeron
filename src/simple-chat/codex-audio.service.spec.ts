import { EventEmitter } from 'node:events';
import type { Mock } from 'vitest';
import { CodexAudioService } from './codex-audio.service';
import type { CodexService } from '../codex/codex.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { serializeCodexAuditEntry } from '../codex/codex-jsonrpc-client';
import { accessContext } from '../auth/access-context';

const offer =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const answer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
async function flush() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
function setup(autoAnswer = true) {
  const client = new EventEmitter() as EventEmitter & {
    request: Mock<
      (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
    >;
  };
  client.request = vi.fn((method: string, params?: unknown) => {
    if (method === 'account/read')
      return Promise.resolve({ account: { type: 'chatgpt' } });
    if (method === 'config/read')
      return Promise.resolve({
        config: { mcp_servers: { global: { command: 'secret-tool' } } },
      });
    if (method === 'thread/start')
      return Promise.resolve({ thread: { id: 'voice-only' } });
    if (method === 'thread/realtime/start' && autoAnswer) {
      const start = params as {
        transport?: { type: string };
        outputModality?: string;
      };
      // Native 0.164.0 validation: WebRTC defaults to v1. Text output is
      // v2-only, while v2 is forbidden for WebRTC. A generic RPC-OK mock hid it.
      queueMicrotask(() =>
        client.emit('notification', {
          method:
            start.transport?.type === 'webrtc' &&
            start.outputModality === 'text'
              ? 'thread/realtime/error'
              : 'thread/realtime/sdp',
          params: {
            threadId: 'voice-only',
            sdp: answer,
            message: 'text realtime output modality requires realtime v2',
          },
        }),
      );
    }
    return Promise.resolve({});
  });
  const admission = new CatalogAdmissionService();
  const service = new CodexAudioService(
    { getClient: () => client } as unknown as CodexService,
    admission,
  );
  return { service, client, admission };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('negotiates WebRTC with the CLI, never websocket or PCM upload; returns only scoped user speech', async () => {
  vi.useFakeTimers();
  const { service, client, admission } = setup();
  const opened = await service.start(offer);
  expect(
    client.request.mock.calls.find(
      ([method]) => method === 'thread/realtime/start',
    )?.[1],
  ).toMatchObject({
    transport: { type: 'webrtc', sdp: offer },
    outputModality: 'audio',
    version: 'v3',
    clientManagedHandoffs: true,
    delegationAckFiller: false,
    flushTranscriptTailOnSessionEnd: false,
  });
  expect(
    client.request.mock.calls.find(
      ([method]) => method === 'thread/start',
    )?.[1],
  ).toMatchObject({
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: {
      mcp_servers: { global: { command: 'secret-tool', enabled: false } },
      features: { apps: false, plugins: false, shell_tool: false },
      web_search: 'disabled',
    },
  });
  for (const [threadId, role, text] of [
    ['unrelated', 'user', 'wrong'],
    ['voice-only', 'assistant', 'not dictation'],
    ['voice-only', 'user', 'Bonjour le helpdesk.'],
  ])
    client.emit('notification', {
      method: 'thread/realtime/transcript/done',
      params: { threadId, role, text },
    });
  const pending = service.finish(opened.id);
  await vi.advanceTimersByTimeAsync(4000);
  await expect(pending).resolves.toEqual({ text: 'Bonjour le helpdesk.' });
  const methods = client.request.mock.calls.map(([method]) => method);
  expect(methods).not.toContain('thread/realtime/appendAudio');
  expect(methods).not.toContain('turn/start');
  expect(methods).toContain('thread/realtime/stop');
  expect(methods).toContain('thread/unsubscribe');
  expect(client.listenerCount('notification')).toBe(0);
  expect(admission.pending()).toHaveLength(0);
});

it('waits for the matching SDP, not the start acknowledgement or another session', async () => {
  const { service, client } = setup(false);
  let settled = false;
  const pending = service.start(offer).then((value) => {
    settled = true;
    return value;
  });
  await flush();
  expect(settled).toBe(false);
  client.emit('notification', {
    method: 'thread/realtime/sdp',
    params: { threadId: 'other', sdp: answer },
  });
  await flush();
  expect(settled).toBe(false);
  client.emit('notification', {
    method: 'thread/realtime/sdp',
    params: { threadId: 'voice-only', sdp: answer },
  });
  const opened = await pending;
  expect(opened.sdp).toBe(answer);
  await service.cancel(opened.id);
});

it('uses canonical user segments once each, excluding assistant segments', async () => {
  vi.useFakeTimers();
  const { service, client } = setup();
  const opened = await service.start(offer);
  for (const [id, role, text] of [
    ['one', 'user', 'Ancien texte'],
    ['one', 'user', 'Premier segment.'],
    ['two', 'assistant', 'Réponse à ignorer'],
    ['three', 'user', 'Deuxième segment.'],
  ])
    client.emit('notification', {
      method: 'thread/realtime/item/completed',
      params: {
        threadId: 'voice-only',
        item: { id, type: 'transcriptSegment', role, text },
      },
    });
  const pending = service.finish(opened.id);
  await vi.advanceTimersByTimeAsync(4000);
  await expect(pending).resolves.toEqual({
    text: 'Premier segment. Deuxième segment.',
  });
});

it('rejects old PCM clients and invalid offers before contacting the CLI; redacts all media and text', async () => {
  const { service, client } = setup();
  await expect(service.transcribe(Buffer.from('recording'))).rejects.toThrow(
    /rechargez la page/,
  );
  await expect(service.start('not-sdp')).rejects.toThrow(
    /WebRTC audio invalide/,
  );
  await expect(
    service.start('v=0\r\nm=audio 9\r\n' + 'x'.repeat(65536)),
  ).rejects.toThrow(/WebRTC audio invalide/);
  expect(client.request).not.toHaveBeenCalled();
  for (const [method, params] of [
    ['thread/realtime/appendAudio', { audio: { data: 'PRIVATE_PCM' } }],
    [
      'thread/realtime/start',
      { transport: { type: 'webrtc', sdp: 'PRIVATE_SDP' } },
    ],
    ['thread/realtime/transcript/done', { text: 'PRIVATE_DRAFT' }],
    [
      'thread/realtime/transcript/delta',
      { role: 'user', delta: 'PRIVATE_DRAFT' },
    ],
  ] as const)
    expect(serializeCodexAuditEntry('out', { method, params })).not.toMatch(
      /PRIVATE_/,
    );
});

it('reports API-key-only voice incompatibility without using keys, leaking errors or retaining admission', async () => {
  const { service, client, admission } = setup(false);
  const logger = vi.spyOn(
    (service as unknown as { logger: { warn: (...args: unknown[]) => void } })
      .logger,
    'warn',
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = service.start(offer);
    const rejected = expect(pending).rejects.toThrow(/exige une clé API/);
    await flush();
    client.emit('notification', {
      method: 'thread/realtime/error',
      params: {
        threadId: 'voice-only',
        message: 'realtime conversation requires API key auth PRIVATE_TOKEN',
      },
    });
    await rejected;
    expect(admission.pending()).toHaveLength(0);
  }
  expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE_TOKEN');
  expect(client.listenerCount('notification')).toBe(0);
});

it.each([
  'text realtime output modality requires realtime v2',
  'AVAS realtime calls require realtime v1 or v3',
  'AVAS realtime calls require conversational realtime',
  'AVAS requires OpenAI-Alpha: quicksilver=v2.',
  'invalid_quicksilver_alpha_header',
])(
  'reports native protocol incompatibility without blaming the account: %s',
  async (message) => {
    const { service, client, admission } = setup(false);
    const logger = vi.spyOn(
      (service as unknown as { logger: { warn: (...args: unknown[]) => void } })
        .logger,
      'warn',
    );
    const pending = service.start(offer);
    const rejected = expect(pending).rejects.toThrow(
      /configuration vocale est incompatible/,
    );
    await flush();
    client.emit('notification', {
      method: 'thread/realtime/error',
      params: { threadId: 'voice-only', message: message + ' PRIVATE_DETAIL' },
    });
    await rejected;
    expect(logger).toHaveBeenCalledWith(
      { phase: 'webrtc', reason: 'protocol-incompatible' },
      'CLI dictation failed',
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE_DETAIL');
    expect(admission.pending()).toHaveLength(0);
    expect(client.listenerCount('notification')).toBe(0);
  },
);

it('does not call an unknown technical error a refusal by the account or microphone', async () => {
  const { service, client } = setup(false);
  const pending = service.start(offer);
  const rejected = expect(pending).rejects.toThrow(/erreur technique/);
  await flush();
  client.emit('notification', {
    method: 'thread/realtime/error',
    params: { threadId: 'voice-only', message: 'PRIVATE_UPSTREAM_DETAIL' },
  });
  await rejected;
});

it('refuses concurrent sessions, binds stop to the authenticated owner, and keeps another owner from closing it', async () => {
  const { service, admission } = setup();
  const identity = (personId: string) =>
    ({
      identity: {
        kind: 'person',
        personId,
        name: personId,
        role: 'administrator',
        active: true,
      },
      identities: { requireAdministrator: vi.fn() },
    }) as unknown as NonNullable<ReturnType<typeof accessContext.getStore>>;
  const alice = identity('alice');
  const opened = await accessContext.run(alice, () => service.start(offer));
  await expect(service.start(offer)).rejects.toThrow(/déjà en cours/);
  await expect(
    accessContext.run(identity('bob'), () => service.cancel(opened.id)),
  ).rejects.toThrow(/n’appartient pas/);
  expect(admission.pending()).toHaveLength(1);
  await accessContext.run(alice, () => service.cancel(opened.id));
  expect(admission.pending()).toHaveLength(0);
});

it('collects the observed Frameless user fragments without requiring a done event', async () => {
  vi.useFakeTimers();
  const { service, client } = setup();
  const opened = await service.start(offer);
  for (const [threadId, role, delta] of [
    ['unrelated', 'user', 'WRONG'],
    ['voice-only', 'assistant', 'WRONG'],
    ['voice-only', 'user', 'Oui,'],
    ['voice-only', 'user', ' oui'],
    ['voice-only', 'user', '  exactement.'],
  ])
    client.emit('notification', {
      method: 'thread/realtime/transcript/delta',
      params: { threadId, role, delta },
    });
  // A delegation's instruction is not a verbatim user transcript.
  client.emit('notification', {
    method: 'thread/realtime/itemAdded',
    params: {
      threadId: 'voice-only',
      item: { type: 'handoff_request', input_transcript: 'DO NOT COPY' },
    },
  });
  const pending = service.finish(opened.id);
  await vi.advanceTimersByTimeAsync(4000);
  await expect(pending).resolves.toEqual({ text: 'Oui, oui  exactement.' });
  expect(
    client.request.mock.calls.some(([method]) => method === 'turn/start'),
  ).toBe(false);
});

it('replaces pending deltas with their final text without duplicating canonical mirrors', async () => {
  vi.useFakeTimers();
  const { service, client } = setup();
  const opened = await service.start(offer);
  const emit = (method: string, data: Record<string, unknown>) =>
    client.emit('notification', {
      method,
      params: { threadId: 'voice-only', ...data },
    });
  emit('thread/realtime/transcript/delta', {
    role: 'user',
    delta: 'Premier seg',
  });
  emit('thread/realtime/transcript/done', {
    role: 'user',
    text: 'Premier segment.',
  });
  emit('thread/realtime/item/completed', {
    item: {
      id: 'one',
      type: 'transcriptSegment',
      role: 'user',
      text: 'Premier segment.',
    },
  });
  emit('thread/realtime/transcript/delta', { role: 'user', delta: 'Deuxième' });
  const pending = service.finish(opened.id);
  await vi.advanceTimersByTimeAsync(3500);
  emit('thread/realtime/transcript/delta', {
    role: 'user',
    delta: ' segment.',
  });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(3999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual({
    text: 'Premier segment. Deuxième segment.',
  });
});

it('interrupts an attempted agent turn, requires its interrupted terminal event and preserves only user dictation', async () => {
  vi.useFakeTimers();
  const { service, client, admission } = setup();
  const opened = await service.start(offer);
  client.emit('notification', {
    method: 'thread/realtime/transcript/delta',
    params: {
      threadId: 'voice-only',
      role: 'user',
      delta: 'Supprime ce fichier.',
    },
  });
  client.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'voice-only', turn: { id: 'unwanted-turn' } },
  });
  await flush();
  expect(
    client.request.mock.calls.find(
      ([method]) => method === 'turn/interrupt',
    )?.[1],
  ).toEqual({ threadId: 'voice-only', turnId: 'unwanted-turn' });
  const pending = service.finish(opened.id);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(4000);
  expect(settled).toBe(false);
  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'voice-only',
      turn: { id: 'unwanted-turn', status: 'interrupted' },
    },
  });
  client.emit('notification', {
    method: 'thread/realtime/transcript/delta',
    params: {
      threadId: 'voice-only',
      role: 'assistant',
      delta: 'ASSISTANT RESPONSE',
    },
  });
  await vi.advanceTimersByTimeAsync(4000);
  await expect(pending).resolves.toEqual({ text: 'Supprime ce fichier.' });
  expect(admission.pending()).toHaveLength(0);
});

it.each(['rejected', 'missing-terminal', 'completed-not-interrupted'])(
  'fails closed if the unwanted turn cannot be confirmed interrupted: %s',
  async (mode) => {
    vi.useFakeTimers();
    const { service, client, admission } = setup();
    const opened = await service.start(offer);
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation((method, ...args) =>
      method === 'turn/interrupt' && mode === 'rejected'
        ? Promise.reject(new Error('PRIVATE'))
        : original(method, ...args),
    );
    client.emit('notification', {
      method: 'thread/realtime/transcript/delta',
      params: {
        threadId: 'voice-only',
        role: 'user',
        delta: 'Texte à conserver seulement si sûr.',
      },
    });
    const pending = service.finish(opened.id);
    const rejected = expect(pending).rejects.toThrow(/interromp|interruption/);
    client.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'voice-only', turn: { id: 'bad' } },
    });
    if (mode === 'completed-not-interrupted')
      client.emit('notification', {
        method: 'turn/completed',
        params: {
          threadId: 'voice-only',
          turn: { id: 'bad', status: 'completed' },
        },
      });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(admission.pending()).toHaveLength(0);
  },
);

it('requires both the interrupt acknowledgement and the matching terminal event even in reversed order', async () => {
  vi.useFakeTimers();
  const { service, client } = setup();
  const opened = await service.start(offer);
  let acknowledge!: () => void;
  const original = client.request.getMockImplementation()!;
  client.request.mockImplementation((method, ...args) =>
    method === 'turn/interrupt'
      ? new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
      : original(method, ...args),
  );
  client.emit('notification', {
    method: 'thread/realtime/transcript/delta',
    params: {
      threadId: 'voice-only',
      role: 'user',
      delta: 'Bonjour.',
    },
  });
  const pending = service.finish(opened.id);
  client.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'voice-only',
      turn: { id: 'guarded' },
    },
  });
  for (const [threadId, id] of [
    ['other', 'guarded'],
    ['voice-only', 'different'],
    ['voice-only', 'guarded'],
  ])
    client.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id, status: 'interrupted' },
      },
    });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(4000);
  expect(settled).toBe(false);
  acknowledge();
  await flush();
  await vi.advanceTimersByTimeAsync(4000);
  await expect(pending).resolves.toEqual({ text: 'Bonjour.' });
});

it('bounds streamed text and never accepts malformed or non-user delta payloads', async () => {
  const { service, client, admission } = setup();
  const opened = await service.start(offer);
  for (const delta of [null, { text: 'WRONG' }, 42])
    client.emit('notification', {
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'voice-only', role: 'user', delta },
    });
  client.emit('notification', {
    method: 'thread/realtime/transcript/delta',
    params: {
      threadId: 'voice-only',
      role: 'user',
      delta: 'x'.repeat(64001),
    },
  });
  await flush();
  await expect(
    Promise.resolve().then(() => service.finish(opened.id)),
  ).rejects.toThrow();
  expect(admission.pending()).toHaveLength(0);
});

it('bounds missing SDP, silence and abandoned recordings, then releases the session', async () => {
  vi.useFakeTimers();
  const first = setup(false);
  const pending = first.service.start(offer);
  const rejected = expect(pending).rejects.toThrow(/démarrage.*expiré/);
  await flush();
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(first.admission.pending()).toHaveLength(0);
  const second = setup();
  const opened = await second.service.start(offer);
  const finishing = second.service.finish(opened.id);
  const silent = expect(finishing).rejects.toThrow(
    /aucune transcription finale/,
  );
  await vi.advanceTimersByTimeAsync(15000);
  await silent;
  expect(second.admission.pending()).toHaveLength(0);
  const third = setup();
  await third.service.start(offer);
  await vi.advanceTimersByTimeAsync(150000);
  expect(third.admission.pending()).toHaveLength(0);
});

it('cleans up when the CLI exits or the application shuts down', async () => {
  const { service, client, admission } = setup();
  await service.start(offer);
  client.emit('close');
  await flush();
  expect(admission.pending()).toHaveLength(0);
  await service.start(offer);
  await service.onModuleDestroy();
  expect(admission.pending()).toHaveLength(0);
  expect(client.listenerCount('notification')).toBe(0);
});
