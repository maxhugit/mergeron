import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { rm, stat } from 'node:fs/promises';
import type { PlatformIdentity } from '../auth/identity.service';
import type { DatabaseService } from '../database/database.service';
import type { ManagerStatusService } from '../settings/manager-status.service';
import { transcriptionJobs } from '../database/schema';
import { TranscriptionsService } from './transcriptions.service';
// Node's built-in SQLite keeps this test free of native addons or account access.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    readFileSync('drizzle/0066_transcription_jobs.sql', 'utf8').replaceAll(
      '--> statement-breakpoint',
      '',
    ),
  );
  const adapter = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      return {
        raw(this: object) {
          statement.setReturnArrays(true);
          return this;
        },
        all(...params: unknown[]) {
          return statement.all(...(params as never[]));
        },
        get(...params: unknown[]) {
          return statement.get(...(params as never[]));
        },
        run(...params: unknown[]) {
          return statement.run(...(params as never[]));
        },
      };
    },
  };
  return {
    sqlite,
    db: drizzle(adapter as never, { schema: { transcriptionJobs } }),
  };
}
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
      { databasePath: '/test-only/' + randomUUID() } as DatabaseService,
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
});
