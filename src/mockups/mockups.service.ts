import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, asc, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  currentAccess,
  requireProjectAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  conversationMockups as mockups,
  conversationMockupRevisions as revisions,
  projectAgentThreads,
  projectAgentToolRequests as receipts,
  projectDeliverableDocuments as documents,
} from '../database/schema';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { mockupArchive } from './mockup-archive';
import {
  MAX_MOCKUP_BYTES,
  MAX_MOCKUP_REVISIONS,
  MAX_PROJECT_MOCKUP_BYTES,
  mockupCreateInput,
  mockupUpdateInput,
  mockupReadInput,
  mockupListInput,
  mockupPublishInput,
} from './mockup.schema';

@Injectable()
export class MockupsService {
  constructor(
    @Inject(DRIZZLE_DB) private db: AppDatabase,
    private deliverables: DeliverablesService,
  ) {}

  private scope(projectId: string, threadId: string) {
    const access = currentAccess();
    if (!access) throw new ForbiddenException('MOCKUP_IDENTITY_REQUIRED');
    access.identities.requireActive(access.identity);
    requireProjectAccess(projectId);
    requireThreadAccess(threadId);
    const binding = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    if (binding?.projectId !== projectId)
      throw new NotFoundException('MOCKUP_NOT_FOUND');
    return access;
  }
  private owned(projectId: string, threadId: string, id: string) {
    this.scope(projectId, threadId);
    const row = this.db
      .select()
      .from(mockups)
      .where(
        and(
          eq(mockups.id, id),
          eq(mockups.projectId, projectId),
          eq(mockups.threadId, threadId),
        ),
      )
      .get();
    if (!row) throw new NotFoundException('MOCKUP_NOT_FOUND');
    return row;
  }
  private reference(
    row: typeof mockups.$inferSelect,
    revision: typeof revisions.$inferSelect,
  ) {
    return {
      type: 'mergeron.mockup' as const,
      projectId: row.projectId,
      threadId: row.threadId,
      id: row.id,
      revision: revision.id,
      number: revision.number,
      title: revision.title,
    };
  }
  read(projectId: string, threadId: string, id: string, revisionId?: string) {
    const row = this.owned(projectId, threadId, id);
    const revision = this.db
      .select()
      .from(revisions)
      .where(
        and(
          eq(revisions.mockupId, row.id),
          eq(revisions.id, revisionId ?? row.currentRevision),
        ),
      )
      .get();
    if (!revision) throw new NotFoundException('MOCKUP_REVISION_NOT_FOUND');
    const history = this.db
      .select({
        id: revisions.id,
        number: revisions.number,
        title: revisions.title,
        authorName: revisions.authorName,
        createdAt: revisions.createdAt,
      })
      .from(revisions)
      .where(eq(revisions.mockupId, row.id))
      .orderBy(asc(revisions.number))
      .all();
    return {
      reference: this.reference(row, revision),
      html: revision.html,
      currentRevision: row.currentRevision,
      history,
    };
  }
  list(projectId: string, threadId: string) {
    this.scope(projectId, threadId);
    return {
      items: this.db
        .select()
        .from(mockups)
        .where(
          and(eq(mockups.projectId, projectId), eq(mockups.threadId, threadId)),
        )
        .orderBy(asc(mockups.createdAt))
        .all()
        .map((row) => {
          const revision = this.db
            .select()
            .from(revisions)
            .where(eq(revisions.id, row.currentRevision))
            .get()!;
          return this.reference(row, revision);
        }),
    };
  }
  private receipt(
    projectId: string,
    threadId: string,
    requestId: string,
    digest: string,
    personId: string | null,
  ) {
    const row = this.db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.projectId, projectId),
          eq(receipts.threadId, threadId),
          eq(receipts.requestId, requestId),
        ),
      )
      .get();
    if (row && (row.digest !== digest || row.personId !== personId))
      throw new ConflictException('MOCKUP_REQUEST_CONFLICT');
    if (row && !row.result)
      throw new ConflictException('MOCKUP_PUBLICATION_UNCONFIRMED');
    return row?.result;
  }
  async tool(
    projectId: string,
    threadId: string,
    input: Record<string, unknown>,
    assertActive: () => void,
    canWrite: boolean,
  ) {
    assertActive();
    const access = this.scope(projectId, threadId);
    const { tool, ...args } = input;
    if (tool === 'project_mockup_list') {
      mockupListInput.parse(args);
      return this.list(projectId, threadId);
    }
    if (tool === 'project_mockup_read' || tool === 'project_mockup_report') {
      const value = mockupReadInput.parse(args);
      const result = this.read(projectId, threadId, value.id, value.revision);
      return tool === 'project_mockup_report'
        ? { reference: result.reference }
        : result;
    }
    if (!canWrite || access.identity.impersonation)
      throw new ForbiddenException('READ_ONLY');
    const personId = access.identity.personId ?? null;
    if (tool === 'project_mockup_publish') {
      const value = mockupPublishInput.parse(args);
      const digest = createHash('sha256')
        .update(JSON.stringify({ tool, ...value }))
        .digest('hex');
      const prior = this.receipt(
        projectId,
        threadId,
        value.requestId,
        digest,
        personId,
      );
      if (prior) return prior;
      const source = this.read(projectId, threadId, value.id, value.revision);
      // Validate the existing target before recording an uncertain external write.
      this.deliverables.get(projectId, value.resourceId, value.deliverableId);
      let filename = `mockup-${value.id}.zip`;
      if (value.documentId) {
        const document = this.db
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.id, value.documentId),
              eq(documents.deliverableId, value.deliverableId),
            ),
          )
          .get();
        if (!document || document.deletedAt !== null)
          throw new NotFoundException('Document not found');
        if (!document.name.toLowerCase().endsWith('.zip'))
          throw new BadRequestException('MOCKUP_ARCHIVE_NEW_DOCUMENT_REQUIRED');
        filename = document.name;
      }
      const archive = mockupArchive(source);
      this.db
        .insert(receipts)
        .values({
          projectId,
          threadId,
          requestId: value.requestId,
          digest,
          personId,
          result: null,
          createdAt: Date.now(),
        })
        .run();
      async function* uploads() {
        await Promise.resolve();
        yield { filename, stream: Readable.from([archive]) };
      }
      const result = await this.deliverables.uploadDocuments(
        projectId,
        value.resourceId,
        value.deliverableId,
        uploads(),
        {
          documentId: value.documentId,
          expectedVersion: value.expectedVersion,
          comment: `Mockup revision ${source.reference.number}`,
          beforeCommit: () => {
            assertActive();
            this.scope(projectId, threadId);
          },
        },
      );
      const output = { reference: source.reference, publication: result };
      this.db
        .update(receipts)
        .set({ result: output })
        .where(
          and(
            eq(receipts.projectId, projectId),
            eq(receipts.threadId, threadId),
            eq(receipts.requestId, value.requestId),
          ),
        )
        .run();
      return output;
    }
    if (tool !== 'project_mockup_create' && tool !== 'project_mockup_manage')
      throw new BadRequestException('MOCKUP_INVALID_REQUEST');
    const update =
      tool === 'project_mockup_manage'
        ? mockupUpdateInput.parse(args)
        : undefined;
    const value = update ?? mockupCreateInput.parse(args);
    const bytes = Buffer.byteLength(value.html, 'utf8');
    if (bytes > MAX_MOCKUP_BYTES)
      throw new BadRequestException('MOCKUP_SIZE_LIMIT');
    const digest = createHash('sha256')
      .update(JSON.stringify({ tool, ...value }))
      .digest('hex');
    return this.db.transaction(() => {
      assertActive();
      this.scope(projectId, threadId);
      const prior = this.receipt(
        projectId,
        threadId,
        value.requestId,
        digest,
        personId,
      );
      if (prior) return prior;
      const old = update
        ? this.owned(projectId, threadId, update.id)
        : undefined;
      const count = old
        ? this.db
            .select({ count: sql<number>`count(*)` })
            .from(revisions)
            .where(eq(revisions.mockupId, old.id))
            .get()!.count
        : 0;
      if (old && old.currentRevision !== update?.baseRevision)
        throw new ConflictException('MOCKUP_REVISION_CONFLICT');
      const usage = this.db
        .select({ bytes: sql<number>`coalesce(sum(${revisions.bytes}), 0)` })
        .from(revisions)
        .innerJoin(mockups, eq(mockups.id, revisions.mockupId))
        .where(eq(mockups.projectId, projectId))
        .get()!.bytes;
      const total = this.db
        .select({ count: sql<number>`count(*)` })
        .from(mockups)
        .where(eq(mockups.projectId, projectId))
        .get()!.count;
      if (
        count >= MAX_MOCKUP_REVISIONS ||
        usage + bytes > MAX_PROJECT_MOCKUP_BYTES ||
        (!old && total >= 50)
      )
        throw new BadRequestException('MOCKUP_QUOTA_EXCEEDED');
      const now = Date.now(),
        id = old?.id ?? randomUUID(),
        revisionId = randomUUID();
      const row = old ?? {
        id,
        projectId,
        threadId,
        currentRevision: revisionId,
        createdAt: now,
      };
      if (!old) this.db.insert(mockups).values(row).run();
      const revision = {
        id: revisionId,
        mockupId: id,
        number: count + 1,
        title: value.title,
        html: value.html,
        bytes,
        authorPersonId: personId,
        authorName: access.identity.name ?? 'Agent',
        createdAt: now,
      };
      this.db.insert(revisions).values(revision).run();
      this.db
        .update(mockups)
        .set({ currentRevision: revisionId })
        .where(eq(mockups.id, id))
        .run();
      const result = { reference: this.reference(row, revision) };
      this.db
        .insert(receipts)
        .values({
          projectId,
          threadId,
          requestId: value.requestId,
          digest,
          personId,
          result,
          createdAt: now,
        })
        .run();
      return result;
    });
  }
}
