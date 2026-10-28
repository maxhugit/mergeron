import { EventEmitter } from 'node:events';
import type { Mock } from 'vitest';
import { CodexAudioService } from './codex-audio.service';
import type { CodexService } from '../codex/codex.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { serializeCodexAuditEntry } from '../codex/codex-jsonrpc-client';

function wav() {
  const b = Buffer.alloc(46);
  b.write('RIFF');
  b.writeUInt32LE(38, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(2, 40);
  return b;
}
function setup() {
  const client = new EventEmitter() as EventEmitter & {
    request: Mock<
      (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
    >;
  };
  client.request = vi.fn((method: string) => {
    if (method === 'account/read')
      return Promise.resolve({ account: { type: 'chatgpt' } });
    if (method === 'config/read')
      return Promise.resolve({
        config: { mcp_servers: { global: { command: 'secret-tool' } } },
      });
    if (method === 'thread/start')
      return Promise.resolve({ thread: { id: 'voice-only' } });
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
});

it('returns only user speech, disables integrations, uses an ephemeral read-only session and always closes it', async () => {
  vi.useFakeTimers();
  const { service, client } = setup();
  const pending = service.transcribe(wav());
  for (let n = 0; n < 30; n++) await Promise.resolve();
  client.emit('notification', {
    method: 'thread/realtime/transcript/done',
    params: { threadId: 'unrelated', role: 'user', text: 'wrong' },
  });
  client.emit('notification', {
    method: 'thread/realtime/transcript/done',
    params: {
      threadId: 'voice-only',
      role: 'assistant',
      text: 'not dictation',
    },
  });
  client.emit('notification', {
    method: 'thread/realtime/transcript/done',
    params: {
      threadId: 'voice-only',
      role: 'user',
      text: 'Bonjour le helpdesk.',
    },
  });
  await vi.advanceTimersByTimeAsync(4000);
  await expect(pending).resolves.toEqual({ text: 'Bonjour le helpdesk.' });
  expect(
    client.request.mock.calls.find(
      ([method]) => method === 'thread/start',
    )?.[1],
  ).toMatchObject({
    ephemeral: true,
    sandbox: 'read-only',
    config: {
      mcp_servers: { global: { command: 'secret-tool', enabled: false } },
    },
  });
  expect(client.request).not.toHaveBeenCalledWith(
    'turn/start',
    expect.anything(),
  );
  expect(client.request.mock.calls.map(([method]) => method)).toContain(
    'thread/realtime/stop',
  );
  expect(client.request.mock.calls.map(([method]) => method)).toContain(
    'thread/unsubscribe',
  );
  expect(client.listenerCount('notification')).toBe(0);
});

it('fails closed on unsupported CLI voice and releases the session for another attempt', async () => {
  const { service, client } = setup();
  client.request.mockImplementation((method: string) => {
    if (method === 'account/read')
      return Promise.resolve({ account: { type: 'chatgpt' } });
    if (method === 'config/read') return Promise.resolve({ config: {} });
    if (method === 'thread/start')
      return Promise.resolve({ thread: { id: 'voice-only' } });
    if (method === 'thread/realtime/start')
      return Promise.reject(
        new Error('Method not found or account unavailable'),
      );
    return Promise.resolve({});
  });
  await expect(service.transcribe(wav())).rejects.toThrow(
    /expérimentale indisponible/,
  );
  await expect(service.transcribe(wav())).rejects.toThrow(
    /expérimentale indisponible/,
  );
  expect(client.listenerCount('notification')).toBe(0);
});

it('rejects invalid audio before contacting the CLI and excludes PCM payloads from the audit', async () => {
  const { service, client } = setup();
  await expect(service.transcribe(Buffer.from('not audio'))).rejects.toThrow(
    /WAV PCM/,
  );
  expect(client.request).not.toHaveBeenCalled();
  const log = serializeCodexAuditEntry('out', {
    id: 3,
    method: 'thread/realtime/appendAudio',
    params: {
      threadId: 'voice',
      audio: { data: 'PRIVATE_BASE64', sampleRate: 24000 },
    },
  });
  expect(log).not.toContain('PRIVATE_BASE64');
  expect(log).toContain('REDACTED_AUDIO');
  expect(
    serializeCodexAuditEntry('in', {
      method: 'thread/realtime/transcript/done',
      params: { text: 'PRIVATE_DRAFT' },
    }),
  ).not.toContain('PRIVATE_DRAFT');
});

it('interrupts any attempted agent turn instead of treating dictation as an instruction', async () => {
  const { service, client, admission } = setup();
  const pending = service.transcribe(wav());
  const rejected = expect(pending).rejects.toThrow(
    /expérimentale indisponible/,
  );
  for (let n = 0; n < 30; n++) await Promise.resolve();
  client.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'voice-only', turn: { id: 'unwanted-turn' } },
  });
  await rejected;
  expect(
    client.request.mock.calls.find(
      ([method]) => method === 'turn/interrupt',
    )?.[1],
  ).toEqual({ threadId: 'voice-only', turnId: 'unwanted-turn' });
  expect(admission.pending()).toHaveLength(0);
});

it('bounds waiting and releases admission on silence', async () => {
  vi.useFakeTimers();
  const { service, admission } = setup();
  const pending = service.transcribe(wav());
  const rejected = expect(pending).rejects.toThrow(
    /expérimentale indisponible/,
  );
  for (let n = 0; n < 30; n++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(90000);
  await rejected;
  expect(admission.pending()).toHaveLength(0);
});
