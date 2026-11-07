import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectKnowledgeProposals as proposals,
  projectKnowledgeSnapshots as snapshots,
  projects,
} from '../database/schema';
import {
  KNOWLEDGE_FILES,
  MAX_KNOWLEDGE_BYTES,
  ProjectKnowledgeService,
  type KnowledgeFiles,
} from './project-knowledge.service';

@Injectable()
export class KnowledgeProposalsService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly knowledge: ProjectKnowledgeService,
  ) {}

  list(projectId: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BadRequestException('Invalid proposal page');
    if (
      !this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    )
      throw new NotFoundException('Project not found');
    const rows = this.db
      .select({
        id: proposals.id,
        projectId: proposals.projectId,
        sourceType: proposals.sourceType,
        threadId: proposals.threadId,
        sourceId: proposals.sourceId,
        title: proposals.title,
        file: proposals.file,
        status: proposals.status,
        version: proposals.version,
        reviewer: proposals.reviewer,
        reviewedAt: proposals.reviewedAt,
        createdAt: proposals.createdAt,
        updatedAt: proposals.updatedAt,
        baseRevision: proposals.baseRevision,
      })
      .from(proposals)
      .where(eq(proposals.projectId, projectId))
      .orderBy(desc(proposals.createdAt))
      .limit(51)
      .offset(offset)
      .all();
    return {
      proposals: rows.slice(0, 50),
      nextOffset: rows.length > 50 ? offset + 50 : null,
    };
  }

  /** Capture only a bounded, explicitly marked assistant proposal, once per response. */
  capture(
    projectId: string,
    source: {
      sourceType: 'agent';
      threadId: string;
      sourceId: string;
    },
    text: string,
  ) {
    const block = /(?:^|\n)```webui-memory-proposal\s*\n([^]*?)\n```/.exec(
      text,
    )?.[1];
    if (!block || Buffer.byteLength(block) > 24000) return null;
    let payload: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(block);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
      payload = value as Record<string, unknown>;
    } catch {
      return null;
    }
    const {
      title,
      file,
      baseRevision,
      operation,
      text: addition,
      before,
    } = payload;
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 160 ||
      typeof file !== 'string' ||
      !KNOWLEDGE_FILES.includes(file as keyof KnowledgeFiles) ||
      typeof baseRevision !== 'string' ||
      typeof addition !== 'string' ||
      Buffer.byteLength(addition) > 8192 ||
      !['append', 'replace'].includes(String(operation))
    )
      return null;
    const base = this.db
      .select()
      .from(snapshots)
      .where(
        and(
          eq(snapshots.projectId, projectId),
          eq(snapshots.revision, baseRevision),
        ),
      )
      .get();
    if (!base) return null;
    const old = base.files[file];
    let proposed: string;
    if (operation === 'append') {
      if (!addition.trim() || old.includes(addition.trim())) return null;
      proposed = `${old.trimEnd()}\n\n${addition.trim()}\n`;
    } else {
      if (
        typeof before !== 'string' ||
        !before ||
        old.split(before).length !== 2
      )
        return null;
      proposed = old.replace(before, () => addition);
    }
    if (proposed === old || Buffer.byteLength(proposed) > MAX_KNOWLEDGE_BYTES)
      return null;
    const now = Date.now();
    const proposal = {
      id: randomUUID(),
      projectId,
      ...source,
      title: title.trim(),
      file,
      baseRevision,
      baseFiles: base.files,
      proposedFiles: { ...base.files, [file]: proposed },
      status: 'pending',
      version: 1,
      reviewer: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (
      this.db
        .select({ id: proposals.id })
        .from(proposals)
        .where(
          and(
            eq(proposals.projectId, projectId),
            eq(proposals.status, 'pending'),
            eq(proposals.baseRevision, baseRevision),
            eq(proposals.file, file),
            eq(proposals.proposedFiles, proposal.proposedFiles),
          ),
        )
        .get()
    )
      return null;
    return (
      this.db
        .insert(proposals)
        .values(proposal)
        .onConflictDoNothing()
        .returning()
        .get() ?? null
    );
  }

  get(projectId: string, id: string) {
    const proposal = this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, id), eq(proposals.projectId, projectId)))
      .get();
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  private async serialize<T>(
    projectId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const operation = (this.queues.get(projectId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    this.queues.set(projectId, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(projectId) === operation)
        this.queues.delete(projectId);
    }
  }

  review(
    projectId: string,
    id: string,
    input: {
      action: 'edit' | 'accept' | 'reject';
      version: number;
      content?: string;
    },
    reviewer: string,
  ) {
    if (
      !input ||
      !['edit', 'accept', 'reject'].includes(input.action) ||
      !Number.isSafeInteger(input.version)
    )
      throw new BadRequestException('Invalid proposal review');
    return this.serialize(projectId, async () => {
      const proposal = this.get(projectId, id);
      if (proposal.status !== 'pending' || proposal.version !== input.version)
        throw new ConflictException(
          'Proposal has already changed. Reload before reviewing.',
        );
      if (input.action === 'edit') {
        if (
          typeof input.content !== 'string' ||
          Buffer.byteLength(input.content) > MAX_KNOWLEDGE_BYTES
        )
          throw new BadRequestException('Invalid proposed file content');
        this.db
          .update(proposals)
          .set({
            proposedFiles: {
              ...proposal.proposedFiles,
              [proposal.file]: input.content,
            },
            version: proposal.version + 1,
            updatedAt: Date.now(),
          })
          .where(eq(proposals.id, id))
          .run();
      } else {
        if (input.action === 'accept') {
          const current = await this.knowledge.read(projectId);
          // Recover a crash between the file save and its review record, on explicit retry.
          const alreadyApplied = KNOWLEDGE_FILES.every(
            (name) => current.files[name] === proposal.proposedFiles[name],
          );
          if (!alreadyApplied)
            await this.knowledge.save(projectId, {
              revision: proposal.baseRevision,
              files: proposal.proposedFiles as KnowledgeFiles,
            });
        }
        const now = Date.now();
        this.db
          .update(proposals)
          .set({
            status: input.action === 'accept' ? 'accepted' : 'rejected',
            reviewer,
            reviewedAt: now,
            updatedAt: now,
            version: proposal.version + 1,
          })
          .where(eq(proposals.id, id))
          .run();
      }
      return this.get(projectId, id);
    });
  }
}
