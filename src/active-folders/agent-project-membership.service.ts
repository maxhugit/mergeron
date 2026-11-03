/** Durable ownership is established before a work agent is returned to callers. */
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectActiveFolders,
  projectAgentThreads,
  projectWorkspaces,
} from '../database/schema';
import { ActiveFoldersService } from './active-folders.service';

@Injectable()
export class AgentProjectMembershipService {
  private readonly logger = new Logger(AgentProjectMembershipService.name);
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly folders: ActiveFoldersService,
  ) {}

  requireLocation(cwd?: string | null, projectId?: string) {
    const location = this.folders.executionLocationForCwd(cwd, projectId);
    if (!location)
      throw new ConflictException(
        'Select a project folder before creating an agent',
      );
    return location;
  }

  requireSource(threadId: string) {
    const member = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    if (!member)
      throw new ConflictException(
        'Attach the source agent to a project before creating a branch',
      );
    return member;
  }

  bind(threadId: string, cwd: string, projectId: string) {
    const location = this.requireLocation(cwd, projectId);
    const workspace = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, location.workspaceId))
      .get();
    if (!workspace)
      throw new ConflictException('Project folder is unavailable');
    const selection = this.folders.validateAbsoluteSelection(projectId, cwd);
    this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, threadId))
        .get();
      if (existing && existing.projectId !== projectId)
        throw new ConflictException(
          'Conversations cannot be moved between projects',
        );
      if (!existing) {
        const now = Date.now();
        tx.insert(projectAgentThreads)
          .values({
            threadId,
            projectId,
            workspacePath: workspace.path,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      // Do not overwrite a deliberate folder choice on repeated notifications.
      const active = this.folders.get('agent', threadId);
      if (active && active.projectId !== projectId)
        throw new ConflictException(
          'The agent folder belongs to a different project',
        );
      if (!active) this.folders.set(projectId, 'agent', threadId, selection);
    });
  }

  inherit(sourceThreadId: string, childThreadId: string) {
    const source = this.requireSource(sourceThreadId);
    this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, childThreadId))
        .get();
      if (existing && existing.projectId !== source.projectId)
        throw new ConflictException(
          'Conversations cannot be moved between projects',
        );
      const now = Date.now();
      if (!existing)
        tx.insert(projectAgentThreads)
          .values({
            threadId: childThreadId,
            projectId: source.projectId,
            workspacePath: source.workspacePath,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      const childFolder = tx
        .select()
        .from(projectActiveFolders)
        .where(
          and(
            eq(projectActiveFolders.contextType, 'agent'),
            eq(projectActiveFolders.contextId, childThreadId),
          ),
        )
        .get();
      if (childFolder && childFolder.projectId !== source.projectId)
        throw new ConflictException(
          'The agent folder belongs to a different project',
        );
      const folder = tx
        .select()
        .from(projectActiveFolders)
        .where(
          and(
            eq(projectActiveFolders.contextType, 'agent'),
            eq(projectActiveFolders.contextId, sourceThreadId),
          ),
        )
        .get();
      if (folder)
        tx.insert(projectActiveFolders)
          .values({
            ...folder,
            contextId: childThreadId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
    });
  }

  withInherited<T>(sourceId: string, childId: string, commit: () => T): T {
    return this.db.transaction(() => {
      this.inherit(sourceId, childId);
      return commit();
    });
  }

  /** Also recovers a native creation if the process stopped before its HTTP response. */
  observe(thread: {
    id: string;
    cwd: string;
    ephemeral: boolean;
    parentThreadId?: string | null;
    forkedFromId?: string | null;
  }) {
    if (
      thread.ephemeral ||
      this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, thread.id))
        .get()
    )
      return;
    try {
      const parent = thread.parentThreadId ?? thread.forkedFromId;
      if (
        parent &&
        this.db
          .select()
          .from(projectAgentThreads)
          .where(eq(projectAgentThreads.threadId, parent))
          .get()
      ) {
        this.inherit(parent, thread.id);
        return;
      }
      const location = this.folders.executionLocationForCwd(thread.cwd);
      if (location) this.bind(thread.id, thread.cwd, location.projectId);
    } catch {
      // No guessed project and no permission broadening for unknown native contexts.
      this.logger.warn(
        { threadId: thread.id },
        'Native agent project association could not be established',
      );
    }
  }

  /** Repair only explicit, durable references; never guess a project from a title. */
  onModuleInit() {
    for (const folder of this.db
      .select()
      .from(projectActiveFolders)
      .where(eq(projectActiveFolders.contextType, 'agent'))
      .all()) {
      if (
        this.db
          .select()
          .from(projectAgentThreads)
          .where(eq(projectAgentThreads.threadId, folder.contextId))
          .get()
      )
        continue;
      const workspace = this.db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, folder.resourceId))
        .get();
      if (!workspace || workspace.projectId !== folder.projectId) continue;
      this.db
        .insert(projectAgentThreads)
        .values({
          threadId: folder.contextId,
          projectId: folder.projectId,
          workspacePath: workspace.path,
          createdAt: folder.createdAt,
          updatedAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();
    }
  }

  listMembers() {
    return this.db
      .select({
        id: projectAgentThreads.threadId,
        archivedAt: projectAgentThreads.archivedAt,
      })
      .from(projectAgentThreads)
      .all();
  }
}
