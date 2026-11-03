import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { rm, stat } from 'node:fs/promises';
import type { PlatformIdentity } from '../auth/identity.service';
import type { DatabaseService } from '../database/database.service';
import type { ManagerStatusService } from '../settings/manager-status.service';
import { transcriptionJobs } from '../database/schema';
import { mediaTestDatabase as database } from './media-database.testing';
import { TranscriptionsService } from './transcriptions.service';
const identity = (id = 'person-a'): PlatformIdentity => ({
  kind: 'person',
  active: true,
  personId: id,
  name: id,
  role: 'standard',
});
const source = 'a'.repeat(64);
describe('private file transcription jobs', () => {
  let fixture: ReturnType<typeof database>, service: TranscriptionsService;
  let pump: { mockRestore(): void };
  beforeEach(async () => {
    fixture = database();
    service = new TranscriptionsService(
      fixture.db,
      {
        databasePath: join(
          tmpdir(),
          'media-storage-test-' + randomUUID(),
          'db.sqlite',
        ),
      } as DatabaseService,
      {
        transcriptionStatus: () => Promise.resolve({ enabled: true }),
        transcriptionLease: () => Promise.resolve({}),
      } as ManagerStatusService,
    );
    await service.onModuleInit();
    pump = vi
      .spyOn(service as unknown as { pump(): void }, 'pump')
      .mockImplementation(() => {});
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    await rm((service as unknown as { directory: string }).directory, {
      recursive: true,
      force: true,
    });
    await rm(dirname((service as unknown as { artifacts: string }).artifacts), {
      recursive: true,
      force: true,
    });
    fixture.sqlite.close();
    vi.restoreAllMocks();
  });
  it('streams an uploaded file and separates results by person', async () => {
    const job = await service.create(
      identity(),
      'meeting.wav',
      source,
      Readable.from([Buffer.from('audio bytes')]),
    );
    expect(job.state).toBe('queued');
    expect(service.list(identity(), source)).toHaveLength(1);
    expect(service.list(identity('other'), source)).toEqual([]);
    expect(() => service.get(identity('other'), job.id)).toThrow();
    await expect(service.remove(identity('other'), job.id)).rejects.toThrow();
    expect(service.get(identity(), job.id).state).toBe('queued');
    await service.remove(identity(), job.id);
    expect(service.list(identity(), source)).toEqual([]);
  });
  it('does not share results with impersonation sessions or service identities', async () => {
    const job = await service.create(
      identity(),
      'meeting.wav',
      source,
      Readable.from(['abc']),
    );
    const acting = {
      ...identity(),
      impersonation: {
        sessionId: 'session',
        administratorId: 'admin',
        administratorName: 'admin',
        personId: 'person-a',
        personName: 'a',
        expiresAt: Date.now() + 60000,
      },
    };
    expect(() => service.get(acting, job.id)).toThrow();
    expect(() =>
      service.list({ ...identity(), kind: 'service' }, source),
    ).toThrow();
  });
  it('rejects untrusted source keys and a truncated upload without queueing it', async () => {
    await expect(
      service.create(
        identity(),
        'meeting.wav',
        '../secret',
        Readable.from(['x']),
      ),
    ).rejects.toThrow();
    const stream = Object.assign(Readable.from(['partial']), {
      truncated: true,
    });
    await expect(
      service.create(identity(), 'meeting.wav', source, stream),
    ).rejects.toThrow();
    expect(service.list(identity(), source)[0].state).toBe('failed');
  });
  it('bounds concurrent uploads per user', async () => {
    await service.create(identity(), 'one.wav', source, Readable.from(['x']));
    await service.create(identity(), 'two.wav', source, Readable.from(['x']));
    await expect(
      service.create(identity(), 'three.wav', source, Readable.from(['x'])),
    ).rejects.toThrow('TRANSCRIPTION_QUEUE_FULL');
  });
  it('marks pending work interrupted after restart without deleting finished results', async () => {
    const job = await service.create(
      identity(),
      'meeting.wav',
      source,
      Readable.from(['x']),
    );
    await service.onModuleInit();
    expect(service.get(identity(), job.id).state).toBe('interrupted');
    expect(service.get(identity(), job.id).error).toBe(
      'TRANSCRIPTION_INTERRUPTED',
    );
  });
  it('completes the private worker protocol, persists only a validated result and cleans audio', async () => {
    const manager = (service as unknown as { manager: ManagerStatusService })
      .manager;
    const lease = vi.spyOn(manager, 'transcriptionLease').mockResolvedValue({
      state: 'ready',
      transport: {
        url: 'http://test-transcription:8090',
        token: 'a'.repeat(64),
      },
    });
    const result = {
      text: 'Bonjour',
      language: 'fr',
      languageProbability: 0.99,
      duration: 1,
      segments: [{ start: 0, end: 1, text: 'Bonjour', speaker: null }],
      diarization: { state: 'unavailable' },
      model: { name: 'faster-whisper-small', revision: 'a'.repeat(40) },
    };
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            init?.method === 'DELETE'
              ? { removed: true }
              : init?.method === 'POST'
                ? { id: 'accepted' }
                : { state: 'ready', result },
          ),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    pump.mockRestore();
    const job = await service.create(
      identity(),
      'meeting.wav',
      source,
      Readable.from(['audio']),
    );
    await expect
      .poll(() => service.get(identity(), job.id).state)
      .toBe('ready');
    await service.onModuleDestroy();
    expect(service.get(identity(), job.id).result?.text).toBe('Bonjour');
    expect(JSON.stringify(service.get(identity(), job.id))).not.toContain(
      'transport',
    );
    expect(lease).toHaveBeenLastCalledWith(job.id, true);
    expect(
      fetchMock.mock.calls.some((call) => call[1]?.method === 'DELETE'),
    ).toBe(true);
    await expect(
      stat(
        (service as unknown as { directory: string }).directory + '/' + job.id,
      ),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
  it('refuses a Manager transport outside the fixed worker hostname', async () => {
    const manager = (service as unknown as { manager: ManagerStatusService })
      .manager;
    vi.spyOn(manager, 'transcriptionLease').mockResolvedValue({
      state: 'ready',
      transport: { url: 'http://169.254.169.254', token: 'a'.repeat(64) },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    pump.mockRestore();
    const job = await service.create(
      identity(),
      'meeting.wav',
      source,
      Readable.from(['audio']),
    );
    await expect
      .poll(() => service.get(identity(), job.id).state)
      .toBe('failed');
    expect(service.get(identity(), job.id).error).toBe(
      'TRANSCRIPTION_INVALID_TRANSPORT',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('stores a verified extracted MP3 privately and preserves it across restart', async () => {
    const audio = Buffer.from('synthetic mp3');
    const meta = {
      mime: 'audio/mpeg',
      size: audio.length,
      sha256: createHash('sha256').update(audio).digest('hex'),
      duration: 1,
    };
    const manager = (service as unknown as { manager: ManagerStatusService })
      .manager;
    vi.spyOn(manager, 'transcriptionLease').mockResolvedValue({
      state: 'ready',
      transport: {
        url: 'http://test-transcription:8090',
        token: 'a'.repeat(64),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            String(url).endsWith('/audio')
              ? audio
              : JSON.stringify(
                  init?.method === 'DELETE'
                    ? { removed: true }
                    : init?.method === 'POST'
                      ? { id: 'accepted' }
                      : { state: 'ready', result: null, audio: meta },
                ),
          ),
        ),
      ),
    );
    pump.mockRestore();
    const job = await service.create(
      identity(),
      'video.mp4',
      source,
      Readable.from(['video']),
      { operation: 'extract' },
    );
    await expect
      .poll(() => service.get(identity(), job.id).state)
      .toBe('ready');
    await service.onModuleDestroy();
    expect(service.get(identity(), job.id).result).toBeNull();
    expect(service.get(identity(), job.id).audio?.sha256).toBe(meta.sha256);
    await expect(
      service.audioDownload(identity('other'), job.id),
    ).rejects.toThrow();
    await service.onModuleInit();
    const download = await service.audioDownload(identity(), job.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream as AsyncIterable<Uint8Array>)
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(audio);
    expect(download.filename).toMatch(/video-.*\.mp3$/);
    await service.remove(identity(), job.id);
    await expect(
      stat(
        join((service as unknown as { artifacts: string }).artifacts, job.id),
      ),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
  it('never marks a truncated or altered worker audio file ready', async () => {
    const manager = (service as unknown as { manager: ManagerStatusService })
      .manager;
    vi.spyOn(manager, 'transcriptionLease').mockResolvedValue({
      state: 'ready',
      transport: {
        url: 'http://test-transcription:8090',
        token: 'a'.repeat(64),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            String(url).endsWith('/audio')
              ? 'altered'
              : JSON.stringify(
                  init?.method === 'DELETE'
                    ? { removed: true }
                    : init?.method === 'POST'
                      ? { id: 'accepted' }
                      : {
                          state: 'ready',
                          result: null,
                          audio: {
                            size: 7,
                            sha256: 'a'.repeat(64),
                            duration: 1,
                            mime: 'audio/mpeg',
                          },
                        },
                ),
          ),
        ),
      ),
    );
    pump.mockRestore();
    const job = await service.create(
      identity(),
      'video.mp4',
      source,
      Readable.from(['video']),
      { operation: 'extract' },
    );
    await expect
      .poll(() => service.get(identity(), job.id).state)
      .toBe('failed');
    await service.onModuleDestroy();
    expect(service.get(identity(), job.id).audio).toBeNull();
    expect(service.get(identity(), job.id).error).toBe(
      'TRANSCRIPTION_AUDIO_CHANGED',
    );
    await expect(
      stat(
        join((service as unknown as { artifacts: string }).artifacts, job.id),
      ),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
  it('deduplicates retries and rejects a reused request key with changed meaning', async () => {
    const options = {
      operation: 'extract' as const,
      requestKey: 'stable-key',
      requestDigest: 'digest',
    };
    const first = await service.create(
      identity(),
      'video.mp4',
      source,
      Readable.from(['video']),
      options,
    );
    const second = await service.create(
      identity(),
      'video.mp4',
      source,
      Readable.from(['video']),
      options,
    );
    expect(first.id).toBe(second.id);
    await expect(
      service.create(
        identity(),
        'video.mp4',
        source,
        Readable.from(['video']),
        { ...options, requestDigest: 'changed' },
      ),
    ).rejects.toThrow('TRANSCRIPTION_REQUEST_CONFLICT');
  });
  it('reserves disk quota for audio jobs before starting work', async () => {
    fixture.db
      .insert(transcriptionJobs)
      .values({
        id: randomUUID(),
        owner: 'person-a',
        filename: 'large.mp4',
        sourceKey: source,
        state: 'ready',
        operation: 'extract',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        audio: {
          filename: 'large.mp3',
          size: 450 * 1024 ** 2,
          mime: 'audio/mpeg',
          sha256: 'a'.repeat(64),
          duration: 1,
        },
      })
      .run();
    await expect(
      service.create(
        identity(),
        'video.mp4',
        source,
        Readable.from(['video']),
        { operation: 'extract' },
      ),
    ).rejects.toThrow('TRANSCRIPTION_STORAGE_QUOTA');
  });
  it('exposes a partial combined result as audio only when speech recognition failed', async () => {
    const audio = Buffer.from('mp3');
    const metadata = {
      size: 3,
      sha256: createHash('sha256').update(audio).digest('hex'),
      duration: 1,
      mime: 'audio/mpeg',
    };
    const manager = (service as unknown as { manager: ManagerStatusService })
      .manager;
    vi.spyOn(manager, 'transcriptionLease').mockResolvedValue({
      state: 'ready',
      transport: {
        url: 'http://test-transcription:8090',
        token: 'a'.repeat(64),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            String(url).endsWith('/audio')
              ? audio
              : JSON.stringify(
                  init?.method === 'POST'
                    ? { id: 'accepted' }
                    : init?.method === 'DELETE'
                      ? { removed: true }
                      : {
                          state: 'ready',
                          result: null,
                          audio: metadata,
                          transcriptionError: 'TRANSCRIPTION_ENGINE_FAILED',
                        },
                ),
          ),
        ),
      ),
    );
    pump.mockRestore();
    const job = await service.create(
      identity(),
      'video.mp4',
      source,
      Readable.from(['video']),
      { operation: 'both' },
    );
    await expect
      .poll(() => service.get(identity(), job.id).state)
      .toBe('partial');
    await service.onModuleDestroy();
    expect(service.get(identity(), job.id)).toMatchObject({
      error: 'TRANSCRIPTION_ENGINE_FAILED',
      result: null,
      audio: { size: 3 },
    });
    const download = await service.audioDownload(identity(), job.id);
    download.stream.destroy();
    vi.unstubAllGlobals();
  });
  it('marks a restored database reference without its audio file as missing', async () => {
    const id = randomUUID();
    fixture.db
      .insert(transcriptionJobs)
      .values({
        id,
        owner: 'person-a',
        filename: 'video.mp4',
        sourceKey: source,
        operation: 'extract',
        state: 'ready',
        audio: {
          filename: 'audio.mp3',
          size: 3,
          sha256: 'a'.repeat(64),
          duration: 1,
          mime: 'audio/mpeg',
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    await service.onModuleInit();
    expect(service.get(identity(), id)).toMatchObject({
      state: 'failed',
      audio: null,
      error: 'TRANSCRIPTION_AUDIO_MISSING',
    });
    await expect(service.audioDownload(identity(), id)).rejects.toThrow();
  });
});
