import {
  BadRequestException,
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
import { createWriteStream, openAsBlob } from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformIdentity } from '../auth/identity.service';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { DatabaseService } from '../database/database.service';
import { transcriptionJobs as jobs } from '../database/schema';
import { ManagerStatusService } from '../settings/manager-status.service';
import { validateResult } from './transcription-result';

const terminal = ['ready', 'failed', 'cancelled', 'interrupted'];
export const MAX_MEDIA_BYTES = 128 * 1024 ** 2;
const safeCode = (error: unknown) =>
  error instanceof Error && /^TRANSCRIPTION_[A-Z_]+$/.test(error.message)
    ? error.message
    : 'TRANSCRIPTION_PROCESSING_FAILED';
@Injectable()
export class TranscriptionsService implements OnModuleInit, OnModuleDestroy {
  private directory: string;
  private controls = new Map<string, AbortController>();
  private processing: Promise<void> | null = null;
  private closing = false;
  private retentionTimer?: NodeJS.Timeout;
  constructor(
    @Inject(DRIZZLE_DB) private db: AppDatabase,
    database: DatabaseService,
    private manager: ManagerStatusService,
  ) {
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
    const pending = this.db.select().from(jobs).all();
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
      .all();
  }
  get(identity: PlatformIdentity | undefined, id: string) {
    const owner = this.owner(identity);
    const row = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.owner, owner)))
      .get();
    if (!row) throw new NotFoundException();
    return row;
  }
  async create(
    identity: PlatformIdentity | undefined,
    filename: string,
    sourceKey: string,
    stream: Readable & { truncated?: boolean },
  ) {
    const owner = this.owner(identity);
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
        state: 'uploading',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const directory = join(this.directory, id);
    await mkdir(directory, { mode: 0o700 });
    let bytes = 0;
    try {
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
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
    this.db.delete(jobs).where(eq(jobs.id, row.id)).run();
    return { removed: true };
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
    const control = new AbortController();
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
          'Content-Length': String(blob.size),
          'Content-Type': 'application/octet-stream',
        },
        body: blob,
      });
      for (;;) {
        const state = await request('/jobs/' + id);
        if (state.state === 'ready') {
          const result = validateResult(state.result);
          this.update(
            id,
            'ready',
            null,
            result as unknown as Record<string, unknown>,
          );
          break;
        }
        if (state.state === 'failed')
          throw Error(
            typeof state.error === 'string'
              ? state.error
              : 'TRANSCRIPTION_PROCESSING_FAILED',
          );
        if (
          !['decoding', 'loading', 'transcribing', 'diarizing'].includes(
            String(state.state),
          )
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
