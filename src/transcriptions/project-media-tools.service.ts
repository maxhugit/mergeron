import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  currentAccess,
  requireProjectAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectAgentToolRequests,
  projectAgentThreads,
} from '../database/schema';
import { DeliverablesService } from '../deliverables/deliverables.service';
import {
  TranscriptionsService,
  MAX_MEDIA_BYTES,
} from './transcriptions.service';
import {
  projectMediaManageInput,
  projectMediaReadInput,
} from './project-media.schema';

/** Bound project documents only: no caller-chosen filesystem paths, URLs or owner. */
@Injectable()
export class ProjectMediaToolsService {
  constructor(
    @Inject(DRIZZLE_DB) private db: AppDatabase,
    private media: TranscriptionsService,
    private deliverables: DeliverablesService,
  ) {}
  async tool(
    projectId: string,
    threadId: string,
    input: Record<string, unknown>,
    assertActive: () => void,
    canWrite: boolean,
  ) {
    const access = currentAccess();
    if (!access)
      throw new ForbiddenException('MEDIA_AUTHENTICATED_TURN_REQUIRED');
    const check = () => {
      assertActive();
      access.identities.requireActive(access.identity);
      requireThreadAccess(threadId);
      requireProjectAccess(projectId);
      const binding = this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, threadId))
        .get();
      if (binding?.projectId !== projectId)
        throw new ForbiddenException('MEDIA_PROJECT_CHANGED');
    };
    check();
    const { tool, ...args } = input;
    if (tool !== 'project_media_read' && tool !== 'project_media_manage')
      throw new BadRequestException('MEDIA_INVALID_REQUEST');
    const read = tool === 'project_media_read';
    const parsed = read
      ? projectMediaReadInput.safeParse(args)
      : projectMediaManageInput.safeParse(args);
    if (!parsed.success) throw new BadRequestException('MEDIA_INVALID_REQUEST');
    const value = parsed.data;
    const job = (id: string) => {
      const row = this.media.get(access.identity, id);
      if (row.projectId !== projectId || row.threadId !== threadId)
        throw new NotFoundException('MEDIA_JOB_NOT_FOUND');
      return row;
    };
    const summary = (row: ReturnType<TranscriptionsService['get']>) => ({
      id: row.id,
      state: row.state,
      operation: row.operation,
      error: row.error,
      audio: row.audio,
      audioUrl: row.audio
        ? '/api/transcriptions/jobs/' + row.id + '/audio'
        : null,
      transcript: row.result
        ? {
            language: row.result.language,
            duration: row.result.duration,
            diarization: row.result.diarization,
          }
        : null,
    });
    if (value.operation === 'status') return this.media.status(access.identity);
    if (value.operation === 'documents')
      return {
        documents: this.deliverables
          .documents(projectId, value.resourceId, value.deliverableId)
          .filter((d) => !d.deletedAt)
          .slice(0, 50)
          .map((d) => ({
            id: d.id,
            name: d.name,
            versions: d.versions.slice(0, 10).map((v) => ({
              id: v.id,
              number: v.number,
              size: v.size,
              sha256: v.sha256,
            })),
          })),
      };
    if (value.operation === 'job') {
      const row = job(value.jobId);
      const segments = Array.isArray(row.result?.segments)
        ? row.result.segments
        : [];
      const offset = value.offset ?? 0;
      return {
        ...summary(row),
        segments: segments.slice(offset, offset + 100),
        nextOffset: offset + 100 < segments.length ? offset + 100 : null,
      };
    }
    if (!canWrite) throw new ForbiddenException('READ_ONLY');
    access.identities.requireAdministrator(access.identity);
    if (access.identity.impersonation)
      throw new ForbiddenException('MEDIA_IMPERSONATION_FORBIDDEN');
    if (value.operation === 'cancel') {
      job(value.jobId);
      return this.media.remove(access.identity, value.jobId);
    }
    if (value.operation === 'start') {
      const source = await this.deliverables.documentVersionFile(
        projectId,
        value.source.resourceId,
        value.source.deliverableId,
        value.source.documentId,
        value.source.versionId,
      );
      if (source.version.size > MAX_MEDIA_BYTES)
        throw new BadRequestException('TRANSCRIPTION_UPLOAD_LIMIT');
      check();
      const digest = createHash('sha256')
        .update(
          JSON.stringify({
            mode: value.mode,
            source: value.source,
            sha256: source.version.sha256,
          }),
        )
        .digest('hex');
      const requestKey = createHash('sha256')
        .update(
          JSON.stringify([
            access.identity.personId,
            projectId,
            threadId,
            value.requestId,
          ]),
        )
        .digest('hex');
      const handle = await open(
        source.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stream = handle.createReadStream();
      try {
        return summary(
          await this.media.create(
            access.identity,
            source.document.name,
            createHash('sha256')
              .update(JSON.stringify(value.source))
              .digest('hex'),
            stream,
            {
              operation: value.mode,
              projectId,
              threadId,
              requestKey,
              requestDigest: digest,
              expectedSha256: source.version.sha256,
              assertActive: check,
            },
          ),
        );
      } finally {
        stream.destroy();
      }
    }
    const row = job(value.jobId);
    if (!row.audio || !['ready', 'partial'].includes(row.state))
      throw new ConflictException('TRANSCRIPTION_AUDIO_NOT_READY');
    this.deliverables.get(
      projectId,
      value.target.resourceId,
      value.target.deliverableId,
    );
    const key = and(
      eq(projectAgentToolRequests.projectId, projectId),
      eq(projectAgentToolRequests.threadId, threadId),
      eq(projectAgentToolRequests.requestId, value.requestId),
    );
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          operation: 'media_publish',
          jobId: row.id,
          sha256: row.audio.sha256,
          target: value.target,
        }),
      )
      .digest('hex');
    const previous = this.db
      .select()
      .from(projectAgentToolRequests)
      .where(key)
      .get();
    if (previous) {
      if (
        previous.digest !== digest ||
        previous.personId !== access.identity.personId
      )
        throw new ConflictException('MEDIA_REQUEST_CONFLICT');
      if (!previous.result)
        throw new ConflictException('MEDIA_PUBLICATION_UNCONFIRMED');
      return previous.result;
    }
    this.db
      .insert(projectAgentToolRequests)
      .values({
        projectId,
        threadId,
        requestId: value.requestId,
        digest,
        personId: access.identity.personId,
        createdAt: Date.now(),
      })
      .run();
    const audio = await this.media.audioDownload(access.identity, row.id);
    try {
      check();
      const result = await this.deliverables.uploadDocuments(
        projectId,
        value.target.resourceId,
        value.target.deliverableId,
        (async function* () {
          await Promise.resolve();
          yield { filename: audio.filename, stream: audio.stream };
        })(),
        {
          comment: 'Piste audio extraite du document vidéo.',
          beforeCommit: check,
        },
      );
      this.db.update(projectAgentToolRequests).set({ result }).where(key).run();
      return result;
    } finally {
      audio.stream.destroy();
    }
  }
}
