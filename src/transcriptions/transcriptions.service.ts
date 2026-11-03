import { currentAccess } from '../auth/access-context';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, desc, eq, lt, notInArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, openAsBlob, constants } from 'node:fs';
import { lstat, mkdir, rm, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformIdentity } from '../auth/identity.service';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { DatabaseService } from '../database/database.service';
import { transcriptionJobs as jobs } from '../database/schema';
import { ManagerStatusService } from '../settings/manager-status.service';
import { validateResult } from './transcription-result';

export type MediaOperation = 'transcribe' | 'extract' | 'both';
export interface MediaJobOptions {
  assertActive?: () => void;
  operation?: MediaOperation;
  projectId?: string;
  threadId?: string;
  requestKey?: string;
  requestDigest?: string;
  expectedSha256?: string;
}
const jobIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = ['ready', 'partial', 'failed', 'cancelled', 'interrupted'];
export const MAX_MEDIA_BYTES = 128 * 1024 ** 2;
const safeCode = (error: unknown) =>
  error instanceof Error && /^TRANSCRIPTION_[A-Z_]+$/.test(error.message)
    ? error.message
    : 'TRANSCRIPTION_PROCESSING_FAILED';
@Injectable()
export class TranscriptionsService implements OnModuleInit, OnModuleDestroy {
  private directory: string;
  private artifacts: string;
  private cleanupTask: Promise<void> = Promise.resolve();
  private controls = new Map<string, AbortController>();
  private processing: Promise<void> | null = null;
  private closing = false;
  private retentionTimer?: NodeJS.Timeout;
  constructor(
    @Inject(DRIZZLE_DB) private db: AppDatabase,
    database: DatabaseService,
    private manager: ManagerStatusService,
  ) {
    this.artifacts = join(
      dirname(database.databasePath),
      'transcription-media',
    );
    this.directory = join(
      tmpdir(),
      'mergeron-transcription-' +
        createHash('sha256')
          .update(database.databasePath)
          .digest('hex')
          .slice(0, 20),
    );
  }
  async onModuleInit() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw Error('TRANSCRIPTION_TEMP_OWNERSHIP');
    await mkdir(this.artifacts, { recursive: true, mode: 0o700 });
    const artifactStat = await lstat(this.artifacts);
    if (
      !artifactStat.isDirectory() ||
      artifactStat.isSymbolicLink() ||
      artifactStat.uid !== process.getuid?.()
    )
      throw Error('TRANSCRIPTION_STORAGE_OWNERSHIP');
    const pending = this.db.select().from(jobs).all();
    const retained = new Set<string>();
    for (const row of pending) {
      if (
        !jobIdPattern.test(row.id) ||
        !row.audio ||
        !['ready', 'partial'].includes(row.state)
      )
        continue;
      try {
        const parent = await lstat(join(this.artifacts, row.id));
        const file = await lstat(join(this.artifacts, row.id, 'audio.mp3'));
        if (
          parent.isSymbolicLink() ||
          !parent.isDirectory() ||
          file.isSymbolicLink() ||
          !file.isFile() ||
          file.size !== row.audio.size
        )
          throw Error('invalid');
        retained.add(row.id);
      } catch {
        this.db
          .update(jobs)
          .set({
            audio: null,
            state: 'failed',
            error: 'TRANSCRIPTION_AUDIO_MISSING',
            updatedAt: Date.now(),
          })
          .where(eq(jobs.id, row.id))
          .run();
      }
    }
    for (const entry of await readdir(this.artifacts, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        /^[a-f0-9-]{36}$/.test(entry.name) &&
        !retained.has(entry.name)
      )
        await rm(join(this.artifacts, entry.name), {
          recursive: true,
          force: true,
        });
    this.db
      .update(jobs)
      .set({
        state: 'interrupted',
        error: 'TRANSCRIPTION_INTERRUPTED',
        updatedAt: Date.now(),
      })
      .where(notInArray(jobs.state, terminal))
      .run();
    for (const job of pending)
      if (/^[a-f0-9-]{36}$/.test(job.id))
        await rm(join(this.directory, job.id), {
          recursive: true,
          force: true,
        });
    this.prune();
    this.retentionTimer ??= setInterval(() => this.prune(), 3600_000);
    this.retentionTimer.unref();
  }
  async onModuleDestroy() {
    this.closing = true;
    clearInterval(this.retentionTimer);
    for (const control of this.controls.values()) control.abort();
    await this.processing;
    await this.cleanupTask;
  }
  private owner(identity?: PlatformIdentity) {
    if (!identity?.active || identity.kind !== 'person' || !identity.personId)
      throw new ForbiddenException('TRANSCRIPTION_PERSON_REQUIRED');
    return (
      identity.personId +
      (identity.impersonation ? ':' + identity.impersonation.sessionId : '')
    );
  }
  private prune() {
    const expired = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          lt(jobs.updatedAt, Date.now() - 30 * 86400_000),
          notInArray(jobs.state, [
            'queued',
            'uploading',
            'preparing',
            'decoding',
            'extracting',
            'loading',
            'transcribing',
            'diarizing',
          ]),
        ),
      )
      .all();
    for (const row of expired.filter((row) => jobIdPattern.test(row.id)))
      this.cleanupTask = this.cleanupTask
        .then(() =>
          rm(join(this.artifacts, row.id), { recursive: true, force: true }),
        )
        .catch(() => undefined);
    this.db
      .delete(jobs)
      .where(
        and(
          lt(jobs.updatedAt, Date.now() - 30 * 86400_000),
          notInArray(jobs.state, [
            'queued',
            'uploading',
            'preparing',
            'decoding',
            'extracting',
            'loading',
            'transcribing',
            'diarizing',
          ]),
        ),
      )
      .run();
  }
  async status(identity?: PlatformIdentity) {
    this.owner(identity);
    const status = await this.manager.transcriptionStatus();
    return {
      enabled: status.enabled === true,
      state: status.state,
      error: status.error,
      containerId: status.containerId,
      image: status.image,
      build: status.build,
      updateAvailable: status.updateAvailable,
      updateCheckError: status.updateCheckError,
      maxBytes: MAX_MEDIA_BYTES,
      maxMinutes: 120,
      operations: ['extract', 'transcribe', 'both'],
      audioFormat: {
        format: 'mp3',
        bitrateKbps: 96,
        sampleRate: 44100,
        channels: 2,
      },
      retentionDays: 30,
    };
  }
  list(identity: PlatformIdentity | undefined, sourceKey: string) {
    const owner = this.owner(identity);
    this.prune();
    if (!/^[a-f0-9]{64}$/.test(sourceKey))
      throw new BadRequestException('TRANSCRIPTION_INVALID_SOURCE');
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.owner, owner), eq(jobs.sourceKey, sourceKey)))
      .orderBy(desc(jobs.createdAt))
      .limit(20)
      .all()
      .filter(
        (row) =>
          !row.projectId ||
          Boolean(
            currentAccess()?.identities.canReadProject(
              identity!,
              row.projectId,
            ),
          ),
      );
  }
  get(identity: PlatformIdentity | undefined, id: string) {
    if (!jobIdPattern.test(id)) throw new NotFoundException();
    const owner = this.owner(identity);
    const row = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner)))
      .get();
    if (!row) throw new NotFoundException();
    if (row.projectId) {
      const access = currentAccess();
      if (!access)
        throw new ForbiddenException('MEDIA_PROJECT_ACCESS_REQUIRED');
      access.identities.requireProject(access.identity, row.projectId);
    }
    return row;
  }
  async create(
    identity: PlatformIdentity | undefined,
    filename: string,
    sourceKey: string,
    stream: Readable & { truncated?: boolean },
    options: MediaJobOptions = {},
  ) {
    const owner = this.owner(identity);
    const operation = options.operation ?? 'transcribe';
    if (!['extract', 'both', 'transcribe'].includes(operation))
      throw new BadRequestException('TRANSCRIPTION_INVALID_OPERATION');
    if (options.requestKey) {
      const previous = this.db
        .select()
        .from(jobs)
        .where(eq(jobs.requestKey, options.requestKey))
        .get();
      if (previous) {
        if (
          previous.owner !== owner ||
          previous.requestDigest !== options.requestDigest
        )
          throw new ConflictException('TRANSCRIPTION_REQUEST_CONFLICT');
        stream.destroy();
        return previous;
      }
    }
    if (
      !/^[a-f0-9]{64}$/.test(sourceKey) ||
      typeof filename !== 'string' ||
      !/\.(mp3|wav|m4a|aac|ogg|opus|flac|webm|mp4|mov|mkv|avi)$/i.test(
        filename,
      ) ||
      filename.length > 255
    )
      throw new BadRequestException('TRANSCRIPTION_INVALID_FILE');
    const status = await this.manager.transcriptionStatus();
    if (this.closing || status.enabled !== true)
      throw new ServiceUnavailableException('TRANSCRIPTION_DISABLED');
    this.prune();
    const pending = this.db
      .select()
      .from(jobs)
      .where(notInArray(jobs.state, terminal))
      .all();
    const total =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(jobs)
        .get()?.count ?? 0;
    const personal =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(jobs)
        .where(eq(jobs.owner, owner))
        .get()?.count ?? 0;
    if (
      pending.length >= 4 ||
      pending.filter((j) => j.owner === owner).length >= 2 ||
      total >= 1000 ||
      personal >= 100
    )
      throw new ServiceUnavailableException('TRANSCRIPTION_QUEUE_FULL');
    if (operation !== 'transcribe') {
      const rows = this.db
        .select({
          owner: jobs.owner,
          audio: jobs.audio,
          state: jobs.state,
          operation: jobs.operation,
        })
        .from(jobs)
        .all();
      const reserved = (subset: typeof rows) =>
        subset.reduce(
          (sum, j) =>
            sum +
            (j.audio?.size ??
              (!terminal.includes(j.state) && j.operation !== 'transcribe'
                ? MAX_MEDIA_BYTES
                : 0)),
          0,
        );
      if (
        reserved(rows) + MAX_MEDIA_BYTES > 2 * 1024 ** 3 ||
        reserved(rows.filter((j) => j.owner === owner)) + MAX_MEDIA_BYTES >
          512 * 1024 ** 2
      )
        throw new ServiceUnavailableException('TRANSCRIPTION_STORAGE_QUOTA');
    }
    const id = randomUUID(),
      now = Date.now();
    this.db
      .insert(jobs)
      .values({
        id,
        owner,
        filename: Array.from(filename, (char) =>
          char.charCodeAt(0) < 32 || char === '/' || char === '\\' ? '_' : char,
        ).join(''),
        sourceKey,
        operation,
        projectId: options.projectId,
        threadId: options.threadId,
        requestKey: options.requestKey,
        requestDigest: options.requestDigest,
        state: 'uploading',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const directory = join(this.directory, id);
    await mkdir(directory, { mode: 0o700 });
    let bytes = 0;
    const digest = createHash('sha256');
    try {
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            digest.update(chunk);
            done(
              bytes > MAX_MEDIA_BYTES
                ? new PayloadTooLargeException('TRANSCRIPTION_UPLOAD_LIMIT')
                : null,
              chunk,
            );
          },
        }),
        createWriteStream(join(directory, 'input'), {
          flags: 'wx',
          mode: 0o600,
        }),
        { signal: AbortSignal.timeout(120_000) },
      );
      if (stream.truncated || !bytes)
        throw new PayloadTooLargeException('TRANSCRIPTION_UPLOAD_LIMIT');
      if (
        options.expectedSha256 &&
        digest.digest('hex') !== options.expectedSha256
      )
        throw new ConflictException('TRANSCRIPTION_SOURCE_CHANGED');
      options.assertActive?.();
      this.update(id, 'queued');
      this.pump();
      return this.get(identity, id);
    } catch (error) {
      this.update(id, 'failed', safeCode(error));
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async remove(identity: PlatformIdentity | undefined, id: string) {
    const row = this.get(identity, id);
    const active = this.controls.get(id);
    if (active) active.abort();
    else await rm(join(this.directory, id), { recursive: true, force: true });
    await rm(join(this.artifacts, id), { recursive: true, force: true });
    this.db.delete(jobs).where(eq(jobs.id, row.id)).run();
    return { removed: true };
  }
  async audioDownload(identity: PlatformIdentity | undefined, id: string) {
    const row = this.get(identity, id);
    if (!['ready', 'partial'].includes(row.state) || !row.audio)
      throw new NotFoundException('TRANSCRIPTION_AUDIO_NOT_READY');
    const parent = await lstat(join(this.artifacts, id)).catch(() => null);
    if (!parent?.isDirectory() || parent.isSymbolicLink())
      throw new NotFoundException('TRANSCRIPTION_AUDIO_MISSING');
    const handle = await open(
      join(this.artifacts, id, 'audio.mp3'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new NotFoundException('TRANSCRIPTION_AUDIO_MISSING');
    });
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== row.audio.size)
        throw Error('TRANSCRIPTION_AUDIO_CHANGED');
      return { stream: handle.createReadStream(), ...row.audio };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private async saveAudio(
    id: string,
    filename: string,
    transport: { url: string; token: string },
    metadata: unknown,
    signal: AbortSignal,
  ) {
    const value = metadata as {
      size?: unknown;
      sha256?: unknown;
      duration?: unknown;
      mime?: unknown;
    };
    if (
      !value ||
      !Number.isSafeInteger(value.size) ||
      Number(value.size) <= 0 ||
      Number(value.size) > MAX_MEDIA_BYTES ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.duration !== 'number' ||
      !Number.isFinite(value.duration) ||
      value.duration <= 0 ||
      value.duration > 7200 ||
      value.mime !== 'audio/mpeg'
    )
      throw Error('TRANSCRIPTION_INVALID_AUDIO');
    const response = await fetch(transport.url + '/jobs/' + id + '/audio', {
      headers: { Authorization: 'Bearer ' + transport.token },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      redirect: 'error',
    });
    if (!response.ok || !response.body)
      throw Error('TRANSCRIPTION_AUDIO_UNAVAILABLE');
    await mkdir(join(this.artifacts, id), { mode: 0o700 });
    const digest = createHash('sha256');
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          digest.update(chunk);
          done(
            bytes > Number(value.size)
              ? Error('TRANSCRIPTION_AUDIO_LIMIT')
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(join(this.artifacts, id, 'audio.mp3'), {
        flags: 'wx',
        mode: 0o600,
      }),
      { signal },
    );
    if (bytes !== value.size || digest.digest('hex') !== value.sha256)
      throw Error('TRANSCRIPTION_AUDIO_CHANGED');
    return {
      size: bytes,
      sha256: value.sha256,
      duration: value.duration,
      mime: 'audio/mpeg' as const,
      filename: extractedAudioName(filename, id),
    };
  }
  private update(
    id: string,
    state: string,
    error: string | null = null,
    result: Record<string, unknown> | null = null,
  ) {
    this.db
      .update(jobs)
      .set({ state, error, result, updatedAt: Date.now() })
      .where(eq(jobs.id, id))
      .run();
  }
  private pump() {
    if (this.processing || this.closing) return;
    this.processing = (async () => {
      for (;;) {
        if (this.closing) return;
        const job = this.db
          .select()
          .from(jobs)
          .where(eq(jobs.state, 'queued'))
          .orderBy(asc(jobs.createdAt))
          .get();
        if (!job) return;
        await this.run(job.id);
      }
    })().finally(() => {
      this.processing = null;
      if (
        !this.closing &&
        this.db.select().from(jobs).where(eq(jobs.state, 'queued')).get()
      )
        this.pump();
    });
  }
  private async run(id: string) {
    if (!jobIdPattern.test(id)) {
      this.update(id, 'failed', 'TRANSCRIPTION_INVALID_JOB');
      return;
    }
    const control = new AbortController();
    const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return;
    this.controls.set(id, control);
    const deadline = setTimeout(() => control.abort(), 30 * 60_000);
    deadline.unref();
    let transport: { url: string; token: string } | undefined;
    let renewing = false;
    let renewTask: Promise<void> = Promise.resolve();
    const renew = setInterval(() => {
      if (renewing) return;
      renewing = true;
      renewTask = this.manager
        .transcriptionLease(id)
        .then(() => undefined)
        .catch(() => control.abort())
        .finally(() => {
          renewing = false;
        });
    }, 20_000);
    renew.unref();
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(transport!.url + path, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: 'Bearer ' + transport!.token,
        },
        signal: AbortSignal.any([control.signal, AbortSignal.timeout(60_000)]),
        redirect: 'error',
      });
      if (!response.ok) throw Error('TRANSCRIPTION_WORKER_UNAVAILABLE');
      const text = await readBounded(response, 5 * 1024 ** 2);
      return JSON.parse(text) as Record<string, unknown>;
    };
    try {
      this.update(id, 'preparing');
      const start = Date.now();
      while (!transport) {
        control.signal.throwIfAborted();
        const status = await this.manager.transcriptionLease(id);
        if (status.state === 'error')
          throw Error(
            typeof status.error === 'string'
              ? status.error
              : 'TRANSCRIPTION_START_FAILED',
          );
        if (status.state === 'ready') {
          const value = status.transport as
            | { url?: unknown; token?: unknown }
            | undefined;
          if (
            typeof value?.url !== 'string' ||
            !/^http:\/\/[a-z0-9][a-z0-9-]{0,100}-transcription:8090$/.test(
              value.url,
            ) ||
            typeof value.token !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.token)
          )
            throw Error('TRANSCRIPTION_INVALID_TRANSPORT');
          transport = { url: value.url, token: value.token };
          break;
        }
        if (Date.now() - start > 10 * 60_000)
          throw Error('TRANSCRIPTION_START_TIMEOUT');
        await delay(1500, undefined, { signal: control.signal });
      }
      control.signal.throwIfAborted();
      const blob = await openAsBlob(join(this.directory, id, 'input'));
      await request('/jobs', {
        method: 'POST',
        headers: {
          'X-Job-Id': id,
          'X-Media-Operation': job.operation,
          'Content-Length': String(blob.size),
          'Content-Type': 'application/octet-stream',
        },
        body: blob,
      });
      for (;;) {
        const state = await request('/jobs/' + id);
        if (state.state === 'ready') {
          const partial =
            job.operation === 'both' &&
            state.result === null &&
            state.transcriptionError === 'TRANSCRIPTION_ENGINE_FAILED';
          const result =
            job.operation === 'extract' || partial
              ? null
              : validateResult(state.result);
          const audio =
            job.operation === 'transcribe'
              ? null
              : await this.saveAudio(
                  id,
                  job.filename,
                  transport,
                  state.audio,
                  control.signal,
                );
          this.db
            .update(jobs)
            .set({
              state: partial ? 'partial' : 'ready',
              error: partial ? 'TRANSCRIPTION_ENGINE_FAILED' : null,
              result: result as unknown as Record<string, unknown> | null,
              audio,
              updatedAt: Date.now(),
            })
            .where(eq(jobs.id, id))
            .run();
          break;
        }
        if (state.state === 'failed')
          throw Error(
            typeof state.error === 'string'
              ? state.error
              : 'TRANSCRIPTION_PROCESSING_FAILED',
          );
        if (
          ![
            'decoding',
            'extracting',
            'loading',
            'transcribing',
            'diarizing',
          ].includes(String(state.state))
        )
          throw Error('TRANSCRIPTION_INVALID_RESULT');
        this.update(id, String(state.state));
        await delay(1500, undefined, { signal: control.signal });
      }
    } catch (error) {
      this.update(
        id,
        control.signal.aborted ? 'cancelled' : 'failed',
        control.signal.aborted ? 'TRANSCRIPTION_CANCELLED' : safeCode(error),
      );
    } finally {
      clearTimeout(deadline);
      clearInterval(renew);
      if (transport)
        await fetch(transport.url + '/jobs/' + id, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + transport.token },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        }).catch(() => undefined);
      await renewTask;
      await this.manager.transcriptionLease(id, true).catch(() => undefined);
      await rm(join(this.directory, id), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }).catch(() => {
        this.db
          .update(jobs)
          .set({ error: 'TRANSCRIPTION_CLEANUP_FAILED' })
          .where(eq(jobs.id, id))
          .run();
      });
      const current = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!current || !['ready', 'partial'].includes(current.state))
        await rm(join(this.artifacts, id), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      this.controls.delete(id);
    }
  }
}
async function readBounded(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('TRANSCRIPTION_INVALID_RESULT');
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('TRANSCRIPTION_RESULT_LIMIT');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
  }
}

function extractedAudioName(filename: string, id: string) {
  let label = '';
  for (const char of basename(filename, extname(filename))) {
    if (Buffer.byteLength(label + char) > 140) break;
    label += char;
  }
  return (label || 'audio') + '-' + id + '.mp3';
}
