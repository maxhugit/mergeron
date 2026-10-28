import {
  requireProjectAccess,
  currentAccess,
  canReadThread,
} from '../auth/access-context';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projects,
  projectResources,
  projectDeliverables as items,
  projectDeliverableVersions as versions,
  projectDeliverableDocuments as documents,
  projectDeliverableDocumentVersions as documentVersions,
  projectDeliverableSnapshots as snapshots,
  projectDeliverableLifecycleEvents as lifecycleEvents,
  projectDeliverableValidations as validations,
  projectDeliverableValidationEvents as validationEvents,
  projectWorkspaces,
  projectParticipants,
  projectManagerAssignments,
  projectPersonGroups,
  projectPersonGroupMembers,
  people,
  projectTasks,
  projectActivity,
  projectTaskActivity,
  projectTaskStatuses,
  projectAgentThreads,
  simpleChatThreads,
  type DeliverableFile,
  type DeliverableSnapshotDocument,
} from '../database/schema';
import { FilesService } from '../files/files.service';
import { IdentityService } from '../auth/identity.service';
import {
  PROJECT_SYSTEM_DIRECTORY,
  projectSystemPath,
} from '../projects/workspace-structure';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { documentProtectionEnabled as protectedDocuments } from '../document-publication/document-isolation';
import { registeredDocumentPath } from './document-path-alias';
import {
  migrateDeliverableDocumentRoots,
  regularPath,
  retireProjection,
} from './document-root-migration';

type Item = typeof items.$inferSelect;
export type DeliverableLifecycleStatus =
  | 'draft'
  | 'in_constitution'
  | 'finalized'
  | 'archived';
export interface DeliverableInput {
  title?: string;
  description?: string;
  criteria?: string;
  confidentiality?: 'standard' | 'restricted';
  authorizedGroupIds?: string[];
  assigneeId?: string | null;
  dueAt?: number | null;
  status?: string;
  taskIds?: string[];
  primaryTaskId?: string | null;
  conversations?: Array<{ type: 'agent' | 'simple'; id: string }>;
  version?: number;
}
export interface DeliverableDocumentActor {
  personId: string | null;
  name: string;
}
export interface OnlyOfficeVersionMetadata {
  key: string;
  changes?: Record<string, unknown>;
  serverVersion?: string;
}

export type OnlyOfficeSessionState = 'editing' | 'saving' | 'saved' | 'error';

interface OnlyOfficeSession {
  state: OnlyOfficeSessionState;
  updatedAt: number;
}

const LIFECYCLE_TRANSITIONS: Record<
  DeliverableLifecycleStatus,
  DeliverableLifecycleStatus[]
> = {
  draft: ['in_constitution', 'finalized'],
  in_constitution: ['draft', 'finalized'],
  finalized: ['in_constitution', 'archived'],
  archived: ['finalized'],
};
const MAX_FILE = 100 * 1024 * 1024;

@Injectable()
export class DeliverablesService implements OnModuleInit {
  async onModuleInit() {
    const logger = new Logger(DeliverablesService.name);
    const result = await migrateDeliverableDocumentRoots(this.db, (message) =>
      logger.warn(message),
    );
    if (result.migrated > 0)
      logger.log(
        `Moved ${result.migrated} retained document(s) to their deliverable root; history unchanged`,
      );
  }
  private readonly onlyOfficeSessions = new Map<string, OnlyOfficeSession>();
  private readonly documentWrites = new Map<string, Promise<void>>();

  private async serializeDocumentWrite<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.documentWrites.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.documentWrites.set(id, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.documentWrites.get(id) === next) this.documentWrites.delete(id);
    }
  }

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly files: FilesService,
    private readonly identities: IdentityService,
    private readonly activeFolders: ActiveFoldersService,
  ) {}
  contextForConversation(
    threadId: string,
    type: 'agent' | 'simple' = 'agent',
  ): string | null {
    const projectId =
      type === 'agent'
        ? this.db
            .select()
            .from(projectAgentThreads)
            .where(eq(projectAgentThreads.threadId, threadId))
            .get()?.projectId
        : this.db
            .select()
            .from(simpleChatThreads)
            .where(eq(simpleChatThreads.id, threadId))
            .get()?.projectId;
    if (!projectId) return null;
    const linked = this.db
      .select({
        id: items.id,
        title: items.title,
        description: items.description,
        criteria: items.criteria,
        status: items.status,
        confidentiality: items.confidentiality,
        authorizedGroupIds: items.authorizedGroupIds,
        workspace: projects.workspacePath,
        validatedVersionId: items.validatedVersionId,
      })
      .from(items)
      .innerJoin(projectResources, eq(items.resourceId, projectResources.id))
      .innerJoin(projects, eq(projectResources.projectId, projects.id))
      .where(
        and(
          eq(projects.id, projectId),
          sql`exists (select 1 from json_each(${items.conversations}) where json_extract(value, '$.id') = ${threadId} and json_extract(value, '$.type') = ${type})`,
        ),
      )
      .all();
    return linked.length
      ? '<project_deliverable_context>\nProject deliverables linked to this conversation. Use their goals and validation criteria. Save working files in the indicated directory. Do not claim validation; only a person can validate a submitted version.\n' +
          JSON.stringify(
            linked
              .filter((item) => this.canAccessDeliverable(projectId, item))
              .map((item) => ({
                ...item,
                directory:
                  this.activeFolders.get('deliverable', item.id)
                    ?.effectivePath ?? null,
              })),
          ) +
          '\n</project_deliverable_context>'
      : null;
  }
  agentWorkspace(
    projectId: string,
    resourceId: string,
    id: string,
    version: number,
  ) {
    if (this.get(projectId, resourceId, id).version !== version)
      throw new ConflictException('Deliverable changed');
    return this.activeFolders.resolve('deliverable', id);
  }
  availableAgentIds(projectId: string, resourceId: string, id: string) {
    this.get(projectId, resourceId, id);
    return this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.projectId, projectId))
      .all()
      .filter(
        ({ threadId }) =>
          canReadThread(threadId, 'agent') &&
          this.isUnassignedAgent(projectId, threadId),
      )
      .map(({ threadId }) => threadId);
  }
  private isUnassignedAgent(projectId: string, threadId: string) {
    return (
      Boolean(
        this.db
          .select()
          .from(projectAgentThreads)
          .where(
            and(
              eq(projectAgentThreads.threadId, threadId),
              eq(projectAgentThreads.projectId, projectId),
            ),
          )
          .get(),
      ) &&
      !this.db
        .select({ id: projectTasks.id })
        .from(projectTasks)
        .where(eq(projectTasks.linkedThreadId, threadId))
        .get() &&
      !this.db
        .select({ id: items.id })
        .from(items)
        .where(
          sql`exists (select 1 from json_each(${items.conversations}) where json_extract(value, '$.type') = 'agent' and json_extract(value, '$.id') = ${threadId})`,
        )
        .get()
    );
  }
  registerAgent(
    projectId: string,
    resourceId: string,
    id: string,
    version: number,
    threadId: string,
    taskId?: string | null,
    existing = false,
  ) {
    const item = this.get(projectId, resourceId, id);
    const task = taskId
      ? this.db
          .select()
          .from(projectTasks)
          .where(eq(projectTasks.id, taskId))
          .get()
      : null;
    const parent = task?.parentTaskId
      ? this.db
          .select()
          .from(projectTasks)
          .where(eq(projectTasks.id, task.parentTaskId))
          .get()
      : null;
    const taskResource = task
      ? this.db
          .select()
          .from(projectResources)
          .where(eq(projectResources.id, task.resourceId))
          .get()
      : null;
    const belongsToVisibleTask =
      Boolean(item.primaryTaskId) &&
      task?.parentTaskId === item.primaryTaskId &&
      taskResource?.projectId === projectId &&
      parent?.resourceId === task?.resourceId;
    const belongsToInternalExecution =
      !item.primaryTaskId &&
      taskResource?.projectId === projectId &&
      taskResource.config.internal === true &&
      taskResource.config.purpose === 'deliverable_execution' &&
      parent?.resourceId === task?.resourceId &&
      parent?.labels.includes(`mergeron:deliverable:${item.id}`);
    if (
      taskId &&
      (!task || (!belongsToVisibleTask && !belongsToInternalExecution))
    )
      throw new BadRequestException(
        'The agent must be assigned through an execution subtask associated with the deliverable',
      );
    if (task?.linkedThreadId)
      throw new ConflictException('This subtask already has an agent');
    const folder = this.activeFolders.get('deliverable', id);
    if (!folder || folder.state !== 'ready')
      throw new ConflictException('Deliverable active folder is unresolved');
    const now = Date.now();
    this.db.transaction((tx) => {
      if (existing) {
        if (
          !canReadThread(threadId, 'agent') ||
          !this.isUnassignedAgent(projectId, threadId)
        )
          throw new ConflictException('This agent is no longer available');
      } else
        tx.insert(projectAgentThreads)
          .values({
            threadId,
            projectId,
            workspacePath: this.resource(projectId, resourceId).project
              .workspacePath,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      if (
        !tx
          .update(items)
          .set({
            updatedByName: this.actor().name,
            conversations: [
              ...item.conversations,
              { type: 'agent', id: threadId },
            ],
            version: item.version + 1,
            updatedAt: now,
          })
          .where(and(eq(items.id, id), eq(items.version, version)))
          .run().changes
      )
        throw new ConflictException(
          'Deliverable changed during agent creation',
        );
      if (task) {
        tx.update(projectTasks)
          .set({
            linkedThreadId: threadId,
            executionMode: 'agent',
            agentState: 'ready',
            updatedAt: now,
          })
          .where(eq(projectTasks.id, task.id))
          .run();
        tx.insert(projectTaskActivity)
          .values({
            id: randomUUID(),
            resourceId: task.resourceId,
            taskId: task.id,
            taskTitle: task.title,
            parentTaskId: task.parentTaskId,
            action: 'updated',
            changes: {
              linkedThreadId: { before: null, after: threadId },
              executionMode: { before: task.executionMode, after: 'agent' },
              agentState: { before: task.agentState, after: 'ready' },
            },
            actorPersonId: currentAccess()?.identity.personId ?? null,
            actorName: currentAccess()?.identity.name ?? 'Système',
            createdAt: now,
          })
          .run();
      }
      if (!existing)
        this.activeFolders.set(
          projectId,
          'agent',
          threadId,
          {
            resourceId: folder.resourceId,
            relativePath: folder.relativePath,
          },
          { allowUnboundAgent: true },
        );
    });
  }
  versionFiles(
    projectId: string,
    resourceId: string,
    id: string,
    versionId: string,
  ) {
    this.get(projectId, resourceId, id);
    return this.getVersion(id, versionId).files;
  }
  private resource(projectId: string, resourceId: string) {
    requireProjectAccess(projectId);
    const resource = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.id, resourceId),
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, 'deliverable_board'),
        ),
      )
      .get();
    if (!resource)
      throw new NotFoundException('Deliverables manager not found');
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()!;
    return { resource, project };
  }
  get(projectId: string, resourceId: string, id: string) {
    this.resource(projectId, resourceId);
    const item = this.db
      .select()
      .from(items)
      .where(and(eq(items.id, id), eq(items.resourceId, resourceId)))
      .get();
    if (!item || !this.canAccessDeliverable(projectId, item))
      throw new NotFoundException('Deliverable not found');
    return item;
  }
  private canAccessDeliverable(
    projectId: string,
    item: Pick<Item, 'confidentiality' | 'authorizedGroupIds'>,
  ) {
    if (item.confidentiality !== 'restricted') return true;
    const access = currentAccess();
    if (!access || access.identity.role === 'administrator') return true;
    const personId = access.identity.personId;
    if (!personId) return false;
    const manager = this.db
      .select({ personId: projectManagerAssignments.personId })
      .from(projectManagerAssignments)
      .where(eq(projectManagerAssignments.projectId, projectId))
      .get();
    if (manager?.personId === personId) return true;
    if (!item.authorizedGroupIds.length) return false;
    return Boolean(
      this.db
        .select({ groupId: projectPersonGroupMembers.groupId })
        .from(projectPersonGroupMembers)
        .where(
          and(
            inArray(projectPersonGroupMembers.groupId, item.authorizedGroupIds),
            eq(projectPersonGroupMembers.personId, personId),
          ),
        )
        .get(),
    );
  }
  private options(projectId: string) {
    return {
      assignees: this.db
        .select({ id: people.id, name: people.name })
        .from(projectParticipants)
        .innerJoin(people, eq(projectParticipants.personId, people.id))
        .where(
          and(
            eq(projectParticipants.projectId, projectId),
            eq(people.active, true),
          ),
        )
        .all(),
      taskManagers: this.db
        .select({
          id: projectResources.id,
          name: projectResources.name,
          config: projectResources.config,
        })
        .from(projectResources)
        .where(
          and(
            eq(projectResources.projectId, projectId),
            eq(projectResources.type, 'task_board'),
          ),
        )
        .all()
        .filter((resource) => resource.config.internal !== true)
        .map((resource) => ({ id: resource.id, name: resource.name })),
      personGroups: this.db
        .select({ id: projectPersonGroups.id, name: projectPersonGroups.name })
        .from(projectPersonGroups)
        .where(eq(projectPersonGroups.projectId, projectId))
        .all()
        .sort((a, b) => a.name.localeCompare(b.name)),
      tasks: this.db
        .select({
          id: projectTasks.id,
          title: projectTasks.title,
          resourceId: projectTasks.resourceId,
          parentTaskId: projectTasks.parentTaskId,
          status: projectTaskStatuses.name,
          progress: projectTasks.progress,
          dueAt: projectTasks.dueAt,
          assigneeId: projectTasks.assigneeId,
          assigneeName: people.name,
          linkedThreadId: projectTasks.linkedThreadId,
          resourceConfig: projectResources.config,
        })
        .from(projectTasks)
        .innerJoin(
          projectResources,
          eq(projectTasks.resourceId, projectResources.id),
        )
        .innerJoin(
          projectTaskStatuses,
          eq(projectTasks.statusId, projectTaskStatuses.id),
        )
        .leftJoin(people, eq(projectTasks.assigneeId, people.id))
        .where(eq(projectResources.projectId, projectId))
        .all()
        .filter((task) => task.resourceConfig.internal !== true)
        .map((task) => ({
          id: task.id,
          title: task.title,
          resourceId: task.resourceId,
          parentTaskId: task.parentTaskId,
          status: task.status,
          progress: task.progress,
          dueAt: task.dueAt,
          assigneeId: task.assigneeId,
          assigneeName: task.assigneeName,
          linkedThreadId: task.linkedThreadId,
        })),
      conversations: [
        ...this.db
          .select({ id: projectAgentThreads.threadId })
          .from(projectAgentThreads)
          .where(eq(projectAgentThreads.projectId, projectId))
          .all()
          .map((row) => ({ ...row, type: 'agent' as const, title: row.id })),
        ...this.db
          .select({ id: simpleChatThreads.id, title: simpleChatThreads.title })
          .from(simpleChatThreads)
          .where(eq(simpleChatThreads.projectId, projectId))
          .all()
          .map((row) => ({ ...row, type: 'simple' as const })),
      ],
    };
  }
  board(projectId: string, resourceId: string) {
    const context = this.resource(projectId, resourceId);
    const records = this.db
      .select()
      .from(items)
      .where(eq(items.resourceId, resourceId))
      .orderBy(desc(items.updatedAt))
      .all()
      .filter((item) => this.canAccessDeliverable(projectId, item));
    const history = records.length
      ? this.db
          .select()
          .from(versions)
          .where(
            inArray(
              versions.deliverableId,
              records.map((row) => row.id),
            ),
          )
          .orderBy(desc(versions.number))
          .all()
      : [];
    const documentRows = records.length
      ? this.db
          .select()
          .from(documents)
          .where(
            inArray(
              documents.deliverableId,
              records.map((row) => row.id),
            ),
          )
          .all()
      : [];
    const documentHistory = documentRows.length
      ? this.db
          .select()
          .from(documentVersions)
          .where(
            inArray(
              documentVersions.documentId,
              documentRows.map((row) => row.id),
            ),
          )
          .orderBy(desc(documentVersions.number))
          .all()
      : [];
    const lifecycleHistory = records.length
      ? this.db
          .select()
          .from(lifecycleEvents)
          .where(
            inArray(
              lifecycleEvents.deliverableId,
              records.map((row) => row.id),
            ),
          )
          .orderBy(desc(lifecycleEvents.createdAt))
          .all()
      : [];
    const snapshotHistory = records.length
      ? this.db
          .select()
          .from(snapshots)
          .where(
            inArray(
              snapshots.deliverableId,
              records.map((row) => row.id),
            ),
          )
          .orderBy(desc(snapshots.createdAt))
          .all()
      : [];
    const validationHistory = records.length
      ? this.db
          .select()
          .from(validations)
          .where(
            inArray(
              validations.deliverableId,
              records.map((row) => row.id),
            ),
          )
          .orderBy(desc(validations.requestedAt))
          .all()
      : [];
    const validationEventHistory = records.length
      ? this.db
          .select()
          .from(validationEvents)
          .where(
            inArray(
              validationEvents.deliverableId,
              records.map((row) => row.id),
            ),
          )
          .orderBy(desc(validationEvents.createdAt))
          .all()
      : [];
    const activityHistory = records.length
      ? this.db
          .select()
          .from(projectActivity)
          .where(
            and(
              eq(projectActivity.projectId, projectId),
              eq(projectActivity.entityType, 'deliverable_history'),
              inArray(
                projectActivity.entityId,
                records.map((row) => row.id),
              ),
            ),
          )
          .orderBy(desc(projectActivity.createdAt))
          .all()
      : [];
    return {
      ...context,
      ...this.options(projectId),
      deliverables: records.map((item) => ({
        ...item,
        activityEvents: activityHistory.filter(
          (event) => event.entityId === item.id,
        ),
        activeFolder: this.activeFolders.get('deliverable', item.id),
        validationStatus: this.effectiveValidationStatus(
          item,
          documentRows.filter(
            (document) =>
              document.deliverableId === item.id && document.deletedAt === null,
          ),
          documentHistory,
          snapshotHistory,
          validationHistory.filter(
            (validation) => validation.deliverableId === item.id,
          ),
        ),
        directory:
          this.activeFolders.get('deliverable', item.id)?.effectivePath ??
          path.join(context.project.workspacePath, 'livrables', item.id),
        versions: history.filter(
          (version) =>
            version.deliverableId === item.id &&
            version.files.every((file) => this.canReadSource(file.sourcePath)),
        ),
        documents: documentRows
          .filter((document) => document.deliverableId === item.id)
          .map((document) => ({
            ...document,
            protectedSource: protectedDocuments(),
            versions: documentHistory.filter(
              (version) => version.documentId === document.id,
            ),
          })),
        lifecycleEvents: lifecycleHistory.filter(
          (event) => event.deliverableId === item.id,
        ),
        snapshots: snapshotHistory.filter(
          (snapshot) => snapshot.deliverableId === item.id,
        ),
        validations: validationHistory
          .filter((validation) => validation.deliverableId === item.id)
          .map((validation) => ({
            ...validation,
            effectiveStatus:
              ['pending', 'approved'].includes(validation.status) &&
              !this.snapshotIsCurrent(
                validation.snapshotId,
                documentRows.filter(
                  (document) =>
                    document.deliverableId === item.id &&
                    document.deletedAt === null,
                ),
                documentHistory,
                snapshotHistory,
              )
                ? ('outdated' as const)
                : validation.status,
          })),
        validationEvents: validationEventHistory.filter(
          (event) => event.deliverableId === item.id,
        ),
      })),
    };
  }

  private effectiveValidationStatus(
    item: Item,
    currentDocuments: Array<typeof documents.$inferSelect>,
    versionHistory: Array<typeof documentVersions.$inferSelect>,
    snapshotHistory: Array<typeof snapshots.$inferSelect>,
    validationHistory: Array<typeof validations.$inferSelect>,
  ): Item['validationStatus'] {
    if (!item.validationRequired) return 'not_required';
    const pending =
      item.validationStatus === 'pending'
        ? validationHistory.find(
            (validation) => validation.status === 'pending',
          )
        : undefined;
    if (pending)
      return this.snapshotIsCurrent(
        pending.snapshotId,
        currentDocuments,
        versionHistory,
        snapshotHistory,
      )
        ? 'pending'
        : 'outdated';
    if (
      item.lastApprovedSnapshotId &&
      this.snapshotIsCurrent(
        item.lastApprovedSnapshotId,
        currentDocuments,
        versionHistory,
        snapshotHistory,
      )
    )
      return 'approved';
    if (item.lastApprovedSnapshotId) return 'outdated';
    return item.validationStatus;
  }

  private snapshotIsCurrent(
    snapshotId: string,
    currentDocuments: Array<typeof documents.$inferSelect>,
    versionHistory: Array<typeof documentVersions.$inferSelect>,
    snapshotHistory: Array<typeof snapshots.$inferSelect>,
  ) {
    const snapshot = snapshotHistory.find((entry) => entry.id === snapshotId);
    if (!snapshot || snapshot.documents.length !== currentDocuments.length)
      return false;
    return currentDocuments.every((document) => {
      const version = versionHistory.find(
        (entry) =>
          entry.documentId === document.id &&
          entry.number === document.currentVersionNumber,
      );
      if (!version) return false;
      return snapshot.documents.some(
        (entry) =>
          entry.documentId === document.id &&
          entry.documentVersionId === version.id &&
          entry.sha256 === version.sha256,
      );
    });
  }
  private text(value: unknown, max: number, required = false) {
    if (
      typeof value !== 'string' ||
      value.length > max ||
      (required && !value.trim())
    )
      throw new BadRequestException('Invalid deliverable text');
    return required ? value.trim() : value;
  }
  private changes(projectId: string, input: DeliverableInput, current?: Item) {
    const options = this.options(projectId);
    const assigneeId =
      input.assigneeId === undefined
        ? (current?.assigneeId ?? null)
        : input.assigneeId || null;
    if (
      assigneeId &&
      !options.assignees.some((p) => p.id === assigneeId) &&
      assigneeId !== current?.assigneeId
    )
      throw new BadRequestException(
        'Responsible person must be an active project participant',
      );
    const dueAt =
      input.dueAt === undefined ? (current?.dueAt ?? null) : input.dueAt;
    if (
      dueAt !== null &&
      (!Number.isSafeInteger(dueAt) || dueAt < 0 || dueAt > 8640000000000000)
    )
      throw new BadRequestException('Invalid due date');
    const status = input.status ?? current?.status ?? 'planned';
    if (
      !['planned', 'in_progress', 'review'].includes(status) &&
      !(status === 'validated' && current?.status === 'validated')
    )
      throw new BadRequestException(
        'Validate a submitted version to validate a deliverable',
      );
    const taskIds = input.taskIds ?? current?.taskIds ?? [];
    const primaryTaskId =
      input.primaryTaskId === undefined
        ? (current?.primaryTaskId ?? null)
        : input.primaryTaskId || null;
    const conversations = input.conversations ?? current?.conversations ?? [];
    const confidentiality =
      input.confidentiality ?? current?.confidentiality ?? 'standard';
    if (!['standard', 'restricted'].includes(confidentiality))
      throw new BadRequestException('Invalid deliverable confidentiality');
    const authorizedGroupIds = [
      ...new Set(input.authorizedGroupIds ?? current?.authorizedGroupIds ?? []),
    ];
    if (
      authorizedGroupIds.length > 100 ||
      authorizedGroupIds.some(
        (id) =>
          typeof id !== 'string' ||
          !options.personGroups.some((group) => group.id === id),
      )
    )
      throw new BadRequestException('Groups must belong to this project');
    if (confidentiality === 'restricted' && !authorizedGroupIds.length)
      throw new BadRequestException(
        'A restricted deliverable requires at least one group',
      );
    if (
      !Array.isArray(taskIds) ||
      taskIds.length > 100 ||
      taskIds.some(
        (id) =>
          typeof id !== 'string' ||
          (!options.tasks.some((t) => t.id === id) &&
            !current?.taskIds.includes(id)),
      )
    )
      throw new BadRequestException('Tasks must belong to this project');
    if (
      primaryTaskId &&
      !options.tasks.some(
        (task) => task.id === primaryTaskId && task.parentTaskId === null,
      )
    )
      throw new BadRequestException(
        'Primary task must be a main task in this project',
      );
    if (
      !Array.isArray(conversations) ||
      conversations.length > 100 ||
      conversations.some(
        (link) =>
          !link ||
          !['agent', 'simple'].includes(link.type) ||
          typeof link.id !== 'string' ||
          (!options.conversations.some(
            (c) => c.id === link.id && c.type === link.type,
          ) &&
            !current?.conversations.some(
              (c) => c.id === link.id && c.type === link.type,
            )),
      )
    )
      throw new BadRequestException(
        'Conversations must belong to this project',
      );
    return {
      title:
        input.title === undefined && current
          ? current.title
          : this.text(input.title, 160, true),
      description:
        input.description === undefined
          ? (current?.description ?? '')
          : this.text(input.description, 20000),
      criteria:
        input.criteria === undefined
          ? (current?.criteria ?? '')
          : this.text(input.criteria, 10000),
      confidentiality,
      authorizedGroupIds:
        confidentiality === 'restricted' ? authorizedGroupIds : [],
      assigneeId,
      dueAt,
      status,
      taskIds: [...new Set(taskIds)],
      primaryTaskId,
      conversations,
    };
  }
  private async directory(projectId: string, parts: string[], create = true) {
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project || project.workspaceLayoutVersion < 1)
      throw new ConflictException('Primary workspace is required');
    const system =
      parts[0] === PROJECT_SYSTEM_DIRECTORY &&
      project.workspaceLayoutVersion >= 3;
    let directory = system
      ? path.dirname(project.workspacePath)
      : project.workspacePath;
    const resolvedParts = system
      ? [
          path.basename(path.dirname(projectSystemPath(project.workspacePath))),
          path.basename(project.workspacePath),
          ...parts.slice(1),
        ]
      : parts;
    for (const part of ['', ...resolvedParts]) {
      if (part) {
        directory = path.join(directory, part);
        if (create)
          await fs
            .mkdir(directory, { recursive: false })
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            });
      }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ConflictException(
          'Deliverable directories must not be symbolic links',
        );
    }
    return directory;
  }
  async create(projectId: string, resourceId: string, input: DeliverableInput) {
    this.resource(projectId, resourceId);
    const values = this.changes(projectId, input);
    const id = randomUUID(),
      now = Date.now();
    await this.directory(projectId, ['livrables', id]);
    const actor = this.actor();
    const created = this.db.transaction((tx) => {
      const created = tx
        .insert(items)
        .values({
          id,
          resourceId,
          ...values,
          createdByName: actor.name,
          updatedByName: actor.name,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      tx.insert(lifecycleEvents)
        .values({
          id: randomUUID(),
          deliverableId: id,
          fromStatus: null,
          toStatus: 'draft',
          actorPersonId: actor.personId,
          actorName: actor.name,
          createdAt: now,
        })
        .run();
      return created;
    });
    this.activeFolders.setFromAbsolutePath(
      projectId,
      'deliverable',
      id,
      path.join(
        this.resource(projectId, resourceId).project.workspacePath,
        'livrables',
        id,
      ),
    );
    return created;
  }
  update(
    projectId: string,
    resourceId: string,
    id: string,
    input: DeliverableInput,
  ) {
    const current = this.get(projectId, resourceId, id);
    if (current.lifecycleStatus === 'archived')
      throw new ConflictException('Archived deliverables are read-only');
    if (input.version !== current.version)
      throw new ConflictException('Deliverable changed. Reload before saving.');
    const actor = this.actor();
    const changes = this.changes(projectId, input, current);
    const now = Date.now();
    return this.db.transaction((tx) => {
      const changed = tx
        .update(items)
        .set({
          updatedByName: actor.name,
          ...changes,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(and(eq(items.id, id), eq(items.version, current.version)))
        .returning()
        .get();
      if (!changed)
        throw new ConflictException(
          'Deliverable changed. Reload before saving.',
        );
      const fields = Object.keys(changes).filter(
        (key) =>
          JSON.stringify(current[key as keyof Item]) !==
          JSON.stringify(changes[key as keyof typeof changes]),
      );
      if (fields.length)
        tx.insert(projectActivity)
          .values({
            id: randomUUID(),
            projectId,
            entityType: 'deliverable_history',
            entityId: id,
            action: 'deliverable_updated',
            label: changed.title,
            details: { fields },
            actorPersonId: actor.personId,
            actorName: actor.name,
            createdAt: now,
          })
          .run();
      return changed;
    });
  }

  transitionLifecycle(
    projectId: string,
    resourceId: string,
    id: string,
    input: { target?: unknown; version?: unknown },
  ) {
    const current = this.get(projectId, resourceId, id);
    const target = input.target as DeliverableLifecycleStatus;
    if (
      !Number.isSafeInteger(input.version) ||
      input.version !== current.version
    )
      throw new ConflictException('Deliverable changed. Reload before saving.');
    if (!LIFECYCLE_TRANSITIONS[current.lifecycleStatus].includes(target))
      throw new BadRequestException('Invalid deliverable lifecycle transition');

    const actor = this.actor();
    const now = Date.now();
    let snapshotId: string | null = null;
    let snapshotDocuments: DeliverableSnapshotDocument[] = [];
    if (target === 'finalized' && current.lifecycleStatus !== 'archived') {
      const blockingSession = this.blockingOnlyOfficeSession(id);
      if (blockingSession)
        throw new ConflictException(
          blockingSession.state === 'error'
            ? 'Resolve the OnlyOffice save error before finalizing the deliverable'
            : 'Wait for OnlyOffice documents to finish saving and close their editors before finalizing the deliverable',
        );
      const activeDocuments = this.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.deliverableId, id),
            sql`${documents.deletedAt} is null`,
          ),
        )
        .all();
      if (!activeDocuments.length)
        throw new ConflictException(
          'A deliverable needs at least one document before finalization',
        );
      snapshotDocuments = activeDocuments.map((document) => {
        const version = this.db
          .select()
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.documentId, document.id),
              eq(documentVersions.number, document.currentVersionNumber),
            ),
          )
          .get();
        if (!version)
          throw new ConflictException('A current document version is missing');
        return {
          documentId: document.id,
          documentVersionId: version.id,
          versionNumber: version.number,
          sha256: version.sha256,
        };
      });
      snapshotId = randomUUID();
    }

    return this.db.transaction((tx) => {
      if (snapshotId) {
        tx.insert(snapshots)
          .values({
            id: snapshotId,
            deliverableId: id,
            documents: snapshotDocuments,
            createdByPersonId: actor.personId,
            createdByName: actor.name,
            createdAt: now,
          })
          .run();
      }
      const changed = tx
        .update(items)
        .set({
          updatedByName: actor.name,
          lifecycleStatus: target,
          ...(snapshotId
            ? {
                currentSnapshotId: snapshotId,
                finalizedAt: now,
                finalizedByPersonId: actor.personId,
                finalizedByName: actor.name,
              }
            : {}),
          version: current.version + 1,
          updatedAt: now,
        })
        .where(and(eq(items.id, id), eq(items.version, current.version)))
        .run();
      if (!changed.changes)
        throw new ConflictException('Deliverable changed during transition');
      tx.insert(lifecycleEvents)
        .values({
          id: randomUUID(),
          deliverableId: id,
          fromStatus: current.lifecycleStatus,
          toStatus: target,
          snapshotId,
          actorPersonId: actor.personId,
          actorName: actor.name,
          createdAt: now,
        })
        .run();
      return tx.select().from(items).where(eq(items.id, id)).get()!;
    });
  }

  private actor(): DeliverableDocumentActor {
    const identity = currentAccess()?.identity;
    return {
      personId: identity?.personId ?? null,
      name: identity?.name ?? 'System',
    };
  }

  private requireDocumentMutable(item: Item) {
    if (
      item.lifecycleStatus !== 'draft' &&
      item.lifecycleStatus !== 'in_constitution'
    )
      throw new ConflictException(
        'Reopen the deliverable before changing its documents',
      );
  }
  remove(projectId: string, resourceId: string, id: string, version: number) {
    this.get(projectId, resourceId, id);
    if (
      !this.db
        .delete(items)
        .where(and(eq(items.id, id), eq(items.version, version)))
        .run().changes
    )
      throw new ConflictException(
        'Deliverable changed. Reload before removing.',
      );
    this.activeFolders.removeContext('deliverable', id);
    return { ok: true, filesPreserved: true };
  }
  private async hash(file: string) {
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(file)) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_FILE)
        throw new BadRequestException('File exceeds 100 MiB');
      digest.update(buffer);
    }
    return { sha256: digest.digest('hex'), size };
  }
  async submit(
    projectId: string,
    resourceId: string,
    id: string,
    input: { paths: string[]; note?: string; version: number },
  ) {
    if (protectedDocuments())
      throw new ConflictException(
        'Save documents as new versions before submitting them for validation',
      );
    const current = this.get(projectId, resourceId, id);
    this.requireDocumentMutable(current);
    if (current.version !== input.version)
      throw new ConflictException(
        'Deliverable changed. Reload before submitting.',
      );
    if (
      !Array.isArray(input.paths) ||
      !input.paths.length ||
      input.paths.length > 10 ||
      input.paths.some((value) => typeof value !== 'string')
    )
      throw new BadRequestException('Provide between one and ten file paths');
    const note = this.text(input.note ?? '', 4000);
    const roots = await Promise.all(
      this.db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .all()
        .map((w) => fs.realpath(w.path).catch(() => null)),
    );
    const versionId = randomUUID();
    const folder = await this.directory(projectId, [
      PROJECT_SYSTEM_DIRECTORY,
      'history',
      'deliverables',
      id,
      versionId,
    ]);
    const files: DeliverableFile[] = [];
    try {
      let total = 0;
      for (const [index, source] of input.paths.entries()) {
        const sourcePath = await this.files.resolveSafePath(source);
        // Snapshots are shared project outputs, so never copy server credentials
        // into a project even when an administrator attached a broad workspace.
        this.identities.requireWorkspacePath(sourcePath);
        if (
          !roots.some((root) => root && sourcePath.startsWith(root + path.sep))
        )
          throw new BadRequestException(
            'Files must belong to a project workspace',
          );
        this.files.assertProjectPathMutable(sourcePath);
        const stat = await fs.stat(sourcePath);
        if (
          !stat.isFile() ||
          stat.size > MAX_FILE ||
          (total += stat.size) > 200 * 1024 * 1024
        )
          throw new BadRequestException(
            'Invalid file or version exceeds 200 MiB',
          );
        const name = path.basename(sourcePath),
          snapshotPath = path.join(folder, `${index}-${name}`);
        await fs.copyFile(sourcePath, snapshotPath, constants.COPYFILE_EXCL);
        const after = await fs.stat(sourcePath);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          throw new ConflictException('Source file changed during submission');
        files.push({
          name,
          sourcePath,
          snapshotPath,
          ...(await this.hash(snapshotPath)),
        });
      }
      return this.db.transaction((tx) => {
        const existing = tx
          .select()
          .from(versions)
          .where(eq(versions.deliverableId, id))
          .all();
        const created = tx
          .insert(versions)
          .values({
            id: versionId,
            deliverableId: id,
            number: Math.max(0, ...existing.map((v) => v.number)) + 1,
            note,
            files,
            createdAt: Date.now(),
          })
          .returning()
          .get();
        const access = currentAccess();
        for (const file of files) {
          let document = tx
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.deliverableId, id),
                eq(documents.sourcePath, file.sourcePath),
              ),
            )
            .get();
          if (!document) {
            const documentId = randomUUID();
            document = tx
              .insert(documents)
              .values({
                id: documentId,
                deliverableId: id,
                name: file.name,
                format: path.extname(file.name).slice(1).toLowerCase(),
                sourcePath: file.sourcePath,
                currentVersionNumber: 0,
                createdAt: created.createdAt,
                updatedAt: created.createdAt,
              })
              .returning()
              .get();
          }
          const latest = tx
            .select()
            .from(documentVersions)
            .where(eq(documentVersions.documentId, document.id))
            .orderBy(desc(documentVersions.number))
            .get();
          if (latest?.sha256 === file.sha256) continue;
          const number = (latest?.number ?? 0) + 1;
          tx.insert(documentVersions)
            .values({
              id: randomUUID(),
              documentId: document.id,
              number,
              fileName: file.name,
              sourcePath: file.sourcePath,
              snapshotPath: file.snapshotPath,
              size: file.size,
              sha256: file.sha256,
              authorPersonId: access?.identity.personId ?? null,
              authorName: access?.identity.name ?? 'Utilisateur',
              comment: note,
              createdAt: created.createdAt,
            })
            .run();
          tx.update(documents)
            .set({
              name: file.name,
              format: path.extname(file.name).slice(1).toLowerCase(),
              currentVersionNumber: number,
              deletedAt: null,
              updatedAt: created.createdAt,
            })
            .where(eq(documents.id, document.id))
            .run();
        }
        if (
          !tx
            .update(items)
            .set({
              updatedByName: this.actor().name,
              status: 'review',
              ...(current.lifecycleStatus === 'draft'
                ? { lifecycleStatus: 'in_constitution' as const }
                : {}),
              version: current.version + 1,
              updatedAt: Date.now(),
            })
            .where(and(eq(items.id, id), eq(items.version, current.version)))
            .run().changes
        )
          throw new ConflictException('Deliverable changed during submission');
        if (current.lifecycleStatus === 'draft')
          tx.insert(lifecycleEvents)
            .values({
              id: randomUUID(),
              deliverableId: id,
              fromStatus: 'draft',
              toStatus: 'in_constitution',
              actorPersonId: access?.identity.personId ?? null,
              actorName: access?.identity.name ?? 'Utilisateur',
              createdAt: Date.now(),
            })
            .run();
        return created;
      });
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true });
      throw error;
    }
  }

  documents(projectId: string, resourceId: string, deliverableId: string) {
    this.get(projectId, resourceId, deliverableId);
    const rows = this.db
      .select()
      .from(documents)
      .where(eq(documents.deliverableId, deliverableId))
      .orderBy(desc(documents.updatedAt))
      .all();
    const history = rows.length
      ? this.db
          .select()
          .from(documentVersions)
          .where(
            inArray(
              documentVersions.documentId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(desc(documentVersions.number))
          .all()
      : [];
    return rows.map((document) => ({
      ...document,
      protectedSource: protectedDocuments(),
      versions: history.filter((version) => version.documentId === document.id),
    }));
  }

  async addDocumentVersion(
    projectId: string,
    resourceId: string,
    deliverableId: string,
    input: {
      path?: unknown;
      comment?: unknown;
      expectedVersion?: unknown;
    },
    actor: DeliverableDocumentActor,
    documentId?: string,
    trustedOnlyOffice = false,
  ) {
    return this.serializeDocumentWrite(deliverableId, () =>
      this.addDocumentVersionUnlocked(
        projectId,
        resourceId,
        deliverableId,
        input,
        actor,
        documentId,
        trustedOnlyOffice,
      ),
    );
  }

  private async addDocumentVersionUnlocked(
    projectId: string,
    resourceId: string,
    deliverableId: string,
    input: { path?: unknown; comment?: unknown; expectedVersion?: unknown },
    actor: DeliverableDocumentActor,
    documentId?: string,
    trustedOnlyOffice = false,
  ) {
    const deliverable = this.get(projectId, resourceId, deliverableId);
    this.requireDocumentMutable(deliverable);
    if (typeof input.path !== 'string' || !input.path.trim())
      throw new BadRequestException('Document path is required');
    const comment = this.text(input.comment ?? '', 4000);
    let sourcePath = await this.files.resolveSafePath(input.path);
    if (!trustedOnlyOffice) this.identities.requireWorkspacePath(sourcePath);
    const workspaces = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .all();
    const roots = await Promise.all(
      workspaces.map((workspace) =>
        fs.realpath(workspace.path).catch(() => null),
      ),
    );
    if (!roots.some((root) => root && sourcePath.startsWith(root + path.sep)))
      throw new BadRequestException(
        'Document must belong to a project workspace',
      );
    this.files.assertProjectPathMutable(sourcePath);
    let stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size > MAX_FILE)
      throw new BadRequestException('Invalid document file');
    const fileName = path.basename(sourcePath);
    let document = documentId
      ? this.db
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.id, documentId),
              eq(documents.deliverableId, deliverableId),
            ),
          )
          .get()
      : undefined;
    if (documentId && !document)
      throw new NotFoundException('Document not found');
    if (!document) {
      const duplicate = this.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.deliverableId, deliverableId),
            eq(documents.sourcePath, sourcePath),
          ),
        )
        .get();
      if (duplicate)
        throw new ConflictException(
          'This document already belongs to the deliverable',
        );
    } else if (sourcePath !== document.sourcePath && !protectedDocuments()) {
      throw new BadRequestException(
        'A document version must use the document source path',
      );
    } else if (
      input.expectedVersion !== document.currentVersionNumber ||
      document.deletedAt !== null
    ) {
      throw new ConflictException('Document changed. Reload before saving.');
    }
    const digest = await this.hash(sourcePath);
    const latest = document
      ? this.db
          .select()
          .from(documentVersions)
          .where(eq(documentVersions.documentId, document.id))
          .orderBy(desc(documentVersions.number))
          .get()
      : undefined;
    if (latest?.sha256 === digest.sha256)
      throw new ConflictException('Document content has not changed');
    const id = document?.id ?? randomUUID();
    let replacedProjection = false;
    let projectionPath: string | undefined;
    let newProjectionPath: string | undefined;
    let folder: string | undefined;
    try {
      if (protectedDocuments()) {
        if (document && fileName !== document.name)
          throw new BadRequestException(
            'A document version must keep its document name',
          );
        if (
          !document &&
          this.db
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.deliverableId, deliverableId),
                eq(documents.name, fileName),
              ),
            )
            .get()
        )
          throw new ConflictException(
            'Choose the existing document when publishing a new version',
          );
        const projectionFolder = await this.directory(projectId, [
          'livrables',
          deliverableId,
        ]);
        const target =
          document?.sourcePath ?? path.join(projectionFolder, fileName);
        if (sourcePath !== target) {
          if (this.blockingOnlyOfficeSession(deliverableId))
            throw new ConflictException(
              'Close the document editor before publishing',
            );
          if (
            document &&
            latest &&
            (await this.hash(target)).sha256 !== latest.sha256
          )
            throw new ConflictException(
              'Save pending document changes as a version before replacing the retained source',
            );
          projectionPath = target;
          replacedProjection = Boolean(document);
          try {
            await fs.copyFile(
              sourcePath,
              target,
              document ? 0 : constants.COPYFILE_EXCL,
            );
          } catch (error) {
            if (!document && (error as NodeJS.ErrnoException).code === 'EEXIST')
              throw new ConflictException(
                'A file with this name already exists in the deliverable; it was not overwritten',
              );
            throw error;
          }
          if (!document) newProjectionPath = target;
          if ((await this.hash(target)).sha256 !== digest.sha256) {
            if (document && latest)
              await fs.copyFile(latest.snapshotPath, target);
            throw new ConflictException(
              'Draft changed while saving its version',
            );
          }
          sourcePath = target;
          stat = await fs.stat(sourcePath);
        }
      }
      const versionId = randomUUID();
      const number = (latest?.number ?? 0) + 1;
      folder = await this.directory(projectId, [
        PROJECT_SYSTEM_DIRECTORY,
        'history',
        'deliverables',
        deliverableId,
        'documents',
        id,
        versionId,
      ]);
      const snapshotPath = path.join(folder, fileName);
      await fs.copyFile(sourcePath, snapshotPath, constants.COPYFILE_EXCL);
      const after = await fs.stat(sourcePath);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        (await this.hash(snapshotPath)).sha256 !== digest.sha256
      ) {
        await fs.rm(folder, { recursive: true, force: true });
        throw new ConflictException(
          'Document changed while its version was created',
        );
      }
      const now = Date.now();
      return this.db.transaction((tx) => {
        if (!document) {
          document = tx
            .insert(documents)
            .values({
              id,
              deliverableId,
              name: fileName,
              format: path.extname(fileName).slice(1).toLowerCase(),
              sourcePath,
              currentVersionNumber: number,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
        } else {
          const changed = tx
            .update(documents)
            .set({
              name: fileName,
              format: path.extname(fileName).slice(1).toLowerCase(),
              sourcePath,
              currentVersionNumber: number,
              updatedAt: now,
            })
            .where(
              and(
                eq(documents.id, id),
                eq(documents.currentVersionNumber, latest?.number ?? 0),
              ),
            )
            .run();
          if (!changed.changes)
            throw new ConflictException('Document changed while saving');
        }
        const version = tx
          .insert(documentVersions)
          .values({
            id: versionId,
            documentId: id,
            number,
            fileName,
            sourcePath,
            snapshotPath,
            ...digest,
            authorPersonId: actor.personId,
            authorName: actor.name,
            comment,
            createdAt: now,
          })
          .returning()
          .get();
        const changed = tx
          .update(items)
          .set({
            updatedByName: actor.name,
            ...(deliverable.lifecycleStatus === 'draft'
              ? { lifecycleStatus: 'in_constitution' as const }
              : {}),
            ...(deliverable.status === 'validated'
              ? { status: 'in_progress' }
              : {}),
            version: deliverable.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(items.id, deliverableId),
              eq(items.version, deliverable.version),
            ),
          )
          .run();
        if (!changed.changes)
          throw new ConflictException('Deliverable changed while saving');
        if (deliverable.lifecycleStatus === 'draft') {
          tx.insert(lifecycleEvents)
            .values({
              id: randomUUID(),
              deliverableId,
              fromStatus: 'draft',
              toStatus: 'in_constitution',
              actorPersonId: actor.personId,
              actorName: actor.name,
              createdAt: now,
            })
            .run();
        }
        return { document, version };
      });
    } catch (error) {
      if (folder) await fs.rm(folder, { recursive: true, force: true });
      if (replacedProjection && latest && projectionPath)
        await fs.copyFile(latest.snapshotPath, projectionPath);
      if (newProjectionPath) await fs.unlink(newProjectionPath);
      throw error;
    }
  }

  async captureOnlyOfficeVersion(
    sourcePath: string,
    actor: DeliverableDocumentActor,
    metadata: OnlyOfficeVersionMetadata,
  ) {
    sourcePath = registeredDocumentPath(this.db, sourcePath);
    const linked = this.db
      .select({
        document: documents,
        deliverable: items,
        resource: projectResources,
      })
      .from(documents)
      .innerJoin(items, eq(documents.deliverableId, items.id))
      .innerJoin(projectResources, eq(items.resourceId, projectResources.id))
      .where(eq(documents.sourcePath, sourcePath))
      .get();
    if (!linked || linked.document.deletedAt !== null) return null;
    try {
      const created = await this.addDocumentVersion(
        linked.resource.projectId,
        linked.resource.id,
        linked.deliverable.id,
        {
          path: sourcePath,
          comment: 'Enregistrement OnlyOffice',
          expectedVersion: linked.document.currentVersionNumber,
        },
        actor,
        linked.document.id,
        true,
      );
      this.db
        .update(documentVersions)
        .set({
          onlyofficeKey: metadata.key,
          onlyofficeChanges: metadata.changes,
          onlyofficeServerVersion: metadata.serverVersion,
        })
        .where(eq(documentVersions.id, created.version.id))
        .run();
      return created;
    } catch (error) {
      if (
        error instanceof ConflictException &&
        error.message === 'Document content has not changed'
      )
        return null;
      throw error;
    }
  }

  attachOnlyOfficeChanges(versionId: string, changesPath: string) {
    this.db
      .update(documentVersions)
      .set({ onlyofficeChangesPath: changesPath })
      .where(eq(documentVersions.id, versionId))
      .run();
  }

  onlyOfficeHistory(sourcePath: string) {
    sourcePath = registeredDocumentPath(this.db, sourcePath);
    const document = this.db
      .select()
      .from(documents)
      .where(eq(documents.sourcePath, sourcePath))
      .get();
    if (!document) return null;
    return {
      document,
      versions: this.db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, document.id))
        .orderBy(documentVersions.number)
        .all(),
    };
  }

  onlyOfficeAccess(sourcePath: string) {
    sourcePath = registeredDocumentPath(this.db, sourcePath);
    const linked = this.db
      .select({ document: documents, deliverable: items })
      .from(documents)
      .innerJoin(items, eq(documents.deliverableId, items.id))
      .where(eq(documents.sourcePath, sourcePath))
      .get();
    if (!linked || linked.document.deletedAt !== null) return null;
    return {
      editable:
        linked.deliverable.lifecycleStatus === 'draft' ||
        linked.deliverable.lifecycleStatus === 'in_constitution',
      lifecycleStatus: linked.deliverable.lifecycleStatus,
    };
  }

  updateOnlyOfficeSession(sourcePath: string, state: OnlyOfficeSessionState) {
    sourcePath = registeredDocumentPath(this.db, sourcePath);
    if (state === 'saved') {
      this.onlyOfficeSessions.delete(sourcePath);
      return;
    }
    this.onlyOfficeSessions.set(sourcePath, { state, updatedAt: Date.now() });
  }

  private blockingOnlyOfficeSession(deliverableId: string) {
    const paths = this.db
      .select({ sourcePath: documents.sourcePath })
      .from(documents)
      .where(
        and(
          eq(documents.deliverableId, deliverableId),
          sql`${documents.deletedAt} is null`,
        ),
      )
      .all();
    for (const { sourcePath } of paths) {
      const session = this.onlyOfficeSessions.get(sourcePath);
      if (session) return session;
    }
    return null;
  }

  async renameDocument(
    projectId: string,
    resourceId: string,
    deliverableId: string,
    documentId: string,
    input: {
      name?: unknown;
      expectedName?: unknown;
      expectedVersion?: unknown;
    },
  ) {
    return this.serializeDocumentWrite(deliverableId, async () => {
      const deliverable = this.get(projectId, resourceId, deliverableId);
      this.requireDocumentMutable(deliverable);
      const document = this.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.deliverableId, deliverableId),
          ),
        )
        .get();
      if (!document || document.deletedAt !== null)
        throw new NotFoundException('Document not found');
      if (
        input.expectedVersion !== document.currentVersionNumber ||
        input.expectedName !== document.name
      )
        throw new ConflictException(
          'Document changed. Reload before renaming.',
        );
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (
        !name ||
        Buffer.byteLength(name) > 255 ||
        /[\\/]/.test(name) ||
        Array.from(name).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        ['.', '..'].includes(name) ||
        name.endsWith('.')
      )
        throw new BadRequestException('Invalid document name');
      if (
        path.extname(name).toLowerCase() !==
        path.extname(document.name).toLowerCase()
      )
        throw new BadRequestException('Keep the document file extension');
      if (name === document.name)
        return {
          oldPath: document.sourcePath,
          newPath: document.sourcePath,
          previousFileRetained: false,
        };
      if (this.blockingOnlyOfficeSession(deliverableId))
        throw new ConflictException(
          'Close the document editor before renaming',
        );
      const source = await this.files.resolveSafePath(document.sourcePath);
      this.identities.requireWorkspacePath(source);
      this.files.assertProjectPathMutable(source);
      const workspacePaths = this.db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .all()
        .map((workspace) => workspace.path);
      const roots = await Promise.all(
        workspacePaths.map((workspace) => fs.realpath(workspace)),
      );
      const registeredRoot = [...workspacePaths, ...roots].find((candidate) =>
        document.sourcePath.startsWith(candidate + path.sep),
      );
      if (!registeredRoot)
        throw new BadRequestException(
          'Document must belong to a project workspace',
        );
      await regularPath(registeredRoot, document.sourcePath);
      const root = roots.find((candidate) =>
        source.startsWith(candidate + path.sep),
      );
      if (!root)
        throw new BadRequestException(
          'Document must belong to a project workspace',
        );
      const target = path.join(path.dirname(source), name);
      this.files.assertProjectPathMutable(target);
      if (
        this.db
          .select()
          .from(documents)
          .all()
          .some(
            (other) =>
              other.id !== document.id &&
              (other.sourcePath === target ||
                other.previousSourcePaths.includes(target) ||
                (other.deliverableId === deliverableId && other.name === name)),
          )
      )
        throw new ConflictException('A document already reserves this name');
      const before = await regularPath(root, source);
      const digest = await this.hash(source);
      let copied = false;
      let committed = false;
      try {
        try {
          await fs.copyFile(source, target, constants.COPYFILE_EXCL);
          copied = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new ConflictException('A file already exists with this name');
          throw error;
        }
        const after = await regularPath(root, source);
        await regularPath(root, target);
        if (
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          (await this.hash(source)).sha256 !== digest.sha256 ||
          (await this.hash(target)).sha256 !== digest.sha256
        )
          throw new ConflictException('Document changed during rename');
        const actor = this.actor();
        const now = Date.now();
        this.db.transaction((tx) => {
          const changed = tx
            .update(documents)
            .set({
              name,
              sourcePath: target,
              previousSourcePaths: [
                ...new Set([
                  ...document.previousSourcePaths,
                  document.sourcePath,
                  source,
                ]),
              ].filter((former) => former !== target),
              updatedAt: now,
            })
            .where(
              and(
                eq(documents.id, documentId),
                eq(documents.name, document.name),
                eq(documents.sourcePath, document.sourcePath),
                eq(
                  documents.currentVersionNumber,
                  document.currentVersionNumber,
                ),
              ),
            )
            .run();
          if (changed.changes !== 1)
            throw new ConflictException('Document changed during rename');
          const updated = tx
            .update(items)
            .set({
              updatedAt: now,
              updatedByName: actor.name,
              version: deliverable.version + 1,
            })
            .where(
              and(
                eq(items.id, deliverableId),
                eq(items.version, deliverable.version),
              ),
            )
            .run();
          if (updated.changes !== 1)
            throw new ConflictException('Deliverable changed during rename');
          tx.insert(projectActivity)
            .values({
              id: randomUUID(),
              projectId,
              entityType: 'deliverable_history',
              entityId: deliverableId,
              action: 'deliverable_document_renamed',
              label: name,
              details: { documentId, before: document.name, after: name },
              actorPersonId: actor.personId,
              actorName: actor.name,
              createdAt: now,
            })
            .run();
        });
        committed = true;
        let previousFileRetained = false;
        try {
          await retireProjection(root, source, target, digest.sha256);
        } catch {
          previousFileRetained = true;
        }
        return {
          oldPath: document.sourcePath,
          newPath: target,
          previousFileRetained,
        };
      } catch (error) {
        // A failed commit never removes the original or an unrelated destination.
        if (copied && !committed)
          await retireProjection(root, target, source, digest.sha256).catch(
            () => {},
          );
        throw error;
      }
    });
  }

  setDocumentDeleted(
    projectId: string,
    resourceId: string,
    deliverableId: string,
    documentId: string,
    expectedVersion: unknown,
    deleted: boolean,
  ) {
    const deliverable = this.get(projectId, resourceId, deliverableId);
    this.requireDocumentMutable(deliverable);
    if (!Number.isSafeInteger(expectedVersion))
      throw new BadRequestException('Invalid document version');
    const document = this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.deliverableId, deliverableId),
        ),
      )
      .get();
    if (!document) throw new NotFoundException('Document not found');
    if (document.currentVersionNumber !== expectedVersion)
      throw new ConflictException('Document changed. Reload before saving.');
    if ((document.deletedAt !== null) === deleted) return { ok: true };
    const now = Date.now();
    const actor = this.actor();
    this.db.transaction((tx) => {
      tx.update(documents)
        .set({ deletedAt: deleted ? now : null, updatedAt: now })
        .where(eq(documents.id, documentId))
        .run();
      tx.update(items)
        .set({
          updatedByName: this.actor().name,
          updatedAt: now,
          version: sql`${items.version} + 1`,
        })
        .where(eq(items.id, deliverableId))
        .run();
      tx.insert(projectActivity)
        .values({
          id: randomUUID(),
          projectId,
          entityType: 'deliverable_history',
          entityId: deliverableId,
          action: deleted
            ? 'deliverable_document_deleted'
            : 'deliverable_document_restored',
          label: document.name,
          details: { documentId },
          actorPersonId: actor.personId,
          actorName: actor.name,
          createdAt: now,
        })
        .run();
    });
    return { ok: true };
  }

  private getDocument(deliverableId: string, documentId: string) {
    const document = this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.deliverableId, deliverableId),
        ),
      )
      .get();
    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  private getDocumentVersion(documentId: string, versionId: string) {
    const version = this.db
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.id, versionId),
          eq(documentVersions.documentId, documentId),
        ),
      )
      .get();
    if (!version) throw new NotFoundException('Document version not found');
    return version;
  }

  async documentVersionFile(
    projectId: string,
    resourceId: string,
    deliverableId: string,
    documentId: string,
    versionId: string,
  ) {
    this.get(projectId, resourceId, deliverableId);
    const document = this.getDocument(deliverableId, documentId);
    const version = this.getDocumentVersion(documentId, versionId);
    const folder = await this.directory(
      projectId,
      [
        PROJECT_SYSTEM_DIRECTORY,
        'history',
        'deliverables',
        deliverableId,
        'documents',
        documentId,
        versionId,
      ],
      false,
    );
    const resolved = await fs.realpath(version.snapshotPath);
    if (
      path.dirname(resolved) !== (await fs.realpath(folder)) ||
      (await fs.lstat(version.snapshotPath)).isSymbolicLink()
    )
      throw new ConflictException('Invalid document version file');
    const actual = await this.hash(resolved);
    if (actual.sha256 !== version.sha256 || actual.size !== version.size)
      throw new ConflictException('Document version file was modified');
    return { document, version, path: resolved };
  }

  async restoreDocumentVersion(
    projectId: string,
    resourceId: string,
    deliverableId: string,
    documentId: string,
    versionId: string,
    input: { expectedVersion?: unknown; comment?: unknown },
    actor: DeliverableDocumentActor,
  ) {
    return this.serializeDocumentWrite(deliverableId, () =>
      this.restoreDocumentVersionUnlocked(
        projectId,
        resourceId,
        deliverableId,
        documentId,
        versionId,
        input,
        actor,
      ),
    );
  }
  private async restoreDocumentVersionUnlocked(
    projectId: string,
    resourceId: string,
    deliverableId: string,
    documentId: string,
    versionId: string,
    input: { expectedVersion?: unknown; comment?: unknown },
    actor: DeliverableDocumentActor,
  ) {
    const deliverable = this.get(projectId, resourceId, deliverableId);
    this.requireDocumentMutable(deliverable);
    const document = this.getDocument(deliverableId, documentId);
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion !== document.currentVersionNumber ||
      document.deletedAt !== null
    )
      throw new ConflictException('Document changed. Reload before restoring.');
    const historical = await this.documentVersionFile(
      projectId,
      resourceId,
      deliverableId,
      documentId,
      versionId,
    );
    await fs.copyFile(historical.path, document.sourcePath);
    const result = await this.addDocumentVersionUnlocked(
      projectId,
      resourceId,
      deliverableId,
      {
        path: document.sourcePath,
        expectedVersion: document.currentVersionNumber,
        comment:
          input.comment ??
          `Restauration de la version ${historical.version.number}`,
      },
      actor,
      documentId,
    );
    this.db
      .update(documentVersions)
      .set({ restoredFromVersionId: versionId })
      .where(eq(documentVersions.id, result.version.id))
      .run();
    return result;
  }
  private getVersion(id: string, versionId: string) {
    const version = this.db
      .select()
      .from(versions)
      .where(and(eq(versions.id, versionId), eq(versions.deliverableId, id)))
      .get();
    if (!version) throw new NotFoundException('Deliverable version not found');
    return version;
  }
  async file(
    projectId: string,
    resourceId: string,
    id: string,
    versionId: string,
    index: number,
  ) {
    this.get(projectId, resourceId, id);
    const file = this.getVersion(id, versionId).files[index];
    if (!Number.isSafeInteger(index) || index < 0 || !file)
      throw new NotFoundException('File not found');
    const access = currentAccess();
    if (access && access.identity.role !== 'administrator')
      this.identities.requireWorkspacePath(
        file.sourcePath,
        false,
        access.identity,
      );
    const folder = await this.directory(
      projectId,
      [PROJECT_SYSTEM_DIRECTORY, 'history', 'deliverables', id, versionId],
      false,
    );
    const resolved = await fs.realpath(file.snapshotPath);
    if (
      path.dirname(resolved) !== (await fs.realpath(folder)) ||
      (await fs.lstat(file.snapshotPath)).isSymbolicLink()
    )
      throw new ConflictException('Invalid version file');
    const actual = await this.hash(resolved);
    if (actual.sha256 !== file.sha256 || actual.size !== file.size)
      throw new ConflictException(
        'Version file was modified outside the manager',
      );
    return file;
  }

  private canReadSource(path: string): boolean {
    const access = currentAccess();
    if (!access || access.identity.role === 'administrator') return true;
    try {
      this.identities.requireWorkspacePath(path, false, access.identity);
      return true;
    } catch {
      return false;
    }
  }

  requestValidation(
    projectId: string,
    resourceId: string,
    id: string,
    input: { version: number },
    actor: DeliverableDocumentActor,
  ) {
    const deliverable = this.get(projectId, resourceId, id);
    if (input.version !== deliverable.version)
      throw new ConflictException('Deliverable changed before validation');
    if (!deliverable.validationRequired)
      throw new ConflictException('Validation is not enabled');
    if (
      deliverable.lifecycleStatus !== 'finalized' ||
      !deliverable.currentSnapshotId
    )
      throw new ConflictException(
        'Only a finalized deliverable can be submitted for validation',
      );
    const boardItem = this.board(projectId, resourceId).deliverables.find(
      (entry) => entry.id === id,
    );
    if (!boardItem) throw new NotFoundException('Deliverable not found');
    if (boardItem.validationStatus === 'approved')
      throw new ConflictException('The current snapshot is already approved');
    if (
      boardItem.validations.some((entry) => entry.effectiveStatus === 'pending')
    )
      throw new ConflictException('A validation request is already pending');
    const now = Date.now();
    const snapshotId = deliverable.currentSnapshotId;
    const validationId = randomUUID();
    return this.db.transaction((tx) => {
      let taskId: string | null = null;
      if (deliverable.primaryTaskId) {
        const parent = tx
          .select()
          .from(projectTasks)
          .where(eq(projectTasks.id, deliverable.primaryTaskId))
          .get();
        if (parent) {
          taskId = randomUUID();
          const siblings = tx
            .select({ position: projectTasks.position })
            .from(projectTasks)
            .where(eq(projectTasks.statusId, parent.statusId))
            .all();
          tx.insert(projectTasks)
            .values({
              id: taskId,
              resourceId: parent.resourceId,
              statusId: parent.statusId,
              title: `Valider le livrable : ${deliverable.title}`,
              description: `Vérifier l’instantané ${snapshotId} selon les critères du livrable.`,
              priority: parent.priority,
              parentTaskId: parent.id,
              assigneeId: null,
              subtaskStatus: 'todo',
              workspacePath: parent.workspacePath,
              executionMode: 'manual',
              agentState: 'manual',
              estimateMinutes: 0,
              progress: 0,
              startAt: null,
              dueAt: deliverable.dueAt,
              validationCriteria: deliverable.criteria,
              labels: [],
              linkedThreadId: null,
              linkedSimpleChatId: null,
              linkedFilePath: null,
              position:
                Math.max(-1, ...siblings.map((row) => row.position)) + 1,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
      }
      const validation = tx
        .insert(validations)
        .values({
          id: validationId,
          deliverableId: id,
          snapshotId,
          taskId,
          requestedByPersonId: actor.personId,
          requestedByName: actor.name,
          requestedAt: now,
        })
        .returning()
        .get();
      const changed = tx
        .update(items)
        .set({
          updatedByName: actor.name,
          status: 'review',
          validationStatus: 'pending',
          version: deliverable.version + 1,
          updatedAt: now,
        })
        .where(and(eq(items.id, id), eq(items.version, deliverable.version)))
        .run();
      if (!changed.changes)
        throw new ConflictException(
          'Deliverable changed during validation request',
        );
      return validation;
    });
  }

  setValidationRequirement(
    projectId: string,
    resourceId: string,
    id: string,
    input: { required?: unknown; reason?: unknown; version?: unknown },
    actor: DeliverableDocumentActor,
  ) {
    const deliverable = this.get(projectId, resourceId, id);
    if (input.version !== deliverable.version)
      throw new ConflictException('Deliverable changed. Reload before saving.');
    if (typeof input.required !== 'boolean')
      throw new BadRequestException('Validation requirement is invalid');
    // Keep the runtime validation result in a local primitive. TypeScript does
    // not preserve property narrowing through the transaction callback because
    // the input object could theoretically be mutated before it runs.
    const required = input.required;
    if (required === deliverable.validationRequired) return deliverable;
    const pending = this.db
      .select()
      .from(validations)
      .where(
        and(
          eq(validations.deliverableId, id),
          eq(validations.status, 'pending'),
        ),
      )
      .get();
    if (!required && pending)
      throw new ConflictException(
        'Cancel the pending validation request before disabling validation',
      );
    const reason = this.text(input.reason ?? '', 4_000);
    if (!required && !reason.trim())
      throw new BadRequestException(
        'A reason is required to disable validation',
      );
    const now = Date.now();
    return this.db.transaction((tx) => {
      const changed = tx
        .update(items)
        .set({
          updatedByName: actor.name,
          validationRequired: required,
          validationStatus: 'not_required',
          version: deliverable.version + 1,
          updatedAt: now,
        })
        .where(and(eq(items.id, id), eq(items.version, deliverable.version)))
        .returning()
        .get();
      if (!changed)
        throw new ConflictException(
          'Deliverable changed while updating validation',
        );
      tx.insert(validationEvents)
        .values({
          id: randomUUID(),
          deliverableId: id,
          action: required ? 'enabled' : 'disabled',
          reason: reason || null,
          actorPersonId: actor.personId,
          actorName: actor.name,
          createdAt: now,
        })
        .run();
      return changed;
    });
  }

  cancelValidation(
    projectId: string,
    resourceId: string,
    id: string,
    validationId: string,
    input: { reason?: unknown; version?: unknown },
    actor: DeliverableDocumentActor,
  ) {
    const deliverable = this.get(projectId, resourceId, id);
    if (input.version !== deliverable.version)
      throw new ConflictException('Deliverable changed before cancellation');
    const reason = this.text(input.reason ?? '', 4_000, true);
    const validation = this.db
      .select()
      .from(validations)
      .where(
        and(
          eq(validations.id, validationId),
          eq(validations.deliverableId, id),
        ),
      )
      .get();
    if (!validation || validation.status !== 'pending')
      throw new ConflictException('Validation request is no longer pending');
    const now = Date.now();
    return this.db.transaction((tx) => {
      tx.update(validations)
        .set({
          status: 'cancelled',
          decidedByPersonId: actor.personId,
          decidedByName: actor.name,
          decisionComment: reason,
          decidedAt: now,
        })
        .where(eq(validations.id, validationId))
        .run();
      if (validation.taskId)
        tx.update(projectTasks)
          .set({ subtaskStatus: 'cancelled', updatedAt: now })
          .where(eq(projectTasks.id, validation.taskId))
          .run();
      tx.insert(validationEvents)
        .values({
          id: randomUUID(),
          deliverableId: id,
          action: 'cancelled',
          validationId,
          reason,
          actorPersonId: actor.personId,
          actorName: actor.name,
          createdAt: now,
        })
        .run();
      const changed = tx
        .update(items)
        .set({
          updatedByName: actor.name,
          validationStatus: 'not_required',
          status: 'in_progress',
          version: deliverable.version + 1,
          updatedAt: now,
        })
        .where(and(eq(items.id, id), eq(items.version, deliverable.version)))
        .run();
      if (!changed.changes)
        throw new ConflictException(
          'Deliverable changed during validation cancellation',
        );
      return tx
        .select()
        .from(validations)
        .where(eq(validations.id, validationId))
        .get();
    });
  }

  decideValidation(
    projectId: string,
    resourceId: string,
    id: string,
    validationId: string,
    input: { action: 'approve' | 'reject'; comment?: unknown; version: number },
    actor: DeliverableDocumentActor,
  ) {
    const deliverable = this.get(projectId, resourceId, id);
    if (input.version !== deliverable.version)
      throw new ConflictException('Deliverable changed before the decision');
    const validation = this.db
      .select()
      .from(validations)
      .where(
        and(
          eq(validations.id, validationId),
          eq(validations.deliverableId, id),
        ),
      )
      .get();
    if (!validation || validation.status !== 'pending')
      throw new ConflictException('Validation request is no longer pending');
    if (!['approve', 'reject'].includes(input.action))
      throw new BadRequestException('Invalid validation decision');
    const comment = this.text(input.comment ?? '', 4_000);
    if (input.action === 'reject' && !comment.trim())
      throw new BadRequestException('A rejection reason is required');
    const board = this.board(projectId, resourceId);
    const effective = board.deliverables
      .find((entry) => entry.id === id)
      ?.validations.find((entry) => entry.id === validationId)?.effectiveStatus;
    if (effective === 'outdated')
      throw new ConflictException('The submitted snapshot is outdated');
    if (deliverable.lifecycleStatus !== 'finalized')
      throw new ConflictException(
        'The deliverable must be finalized before a validation decision',
      );
    const now = Date.now();
    return this.db.transaction((tx) => {
      tx.update(validations)
        .set({
          status: input.action === 'approve' ? 'approved' : 'rejected',
          decidedByPersonId: actor.personId,
          decidedByName: actor.name,
          decisionComment: comment,
          decidedAt: now,
        })
        .where(eq(validations.id, validationId))
        .run();
      if (validation.taskId)
        tx.update(projectTasks)
          .set({
            subtaskStatus: input.action === 'approve' ? 'done' : 'todo',
            progress: input.action === 'approve' ? 100 : 0,
            updatedAt: now,
          })
          .where(eq(projectTasks.id, validation.taskId))
          .run();
      const changed = tx
        .update(items)
        .set({
          updatedByName: actor.name,
          status: input.action === 'approve' ? 'validated' : 'in_progress',
          validationStatus:
            input.action === 'approve' ? 'approved' : 'rejected',
          ...(input.action === 'approve'
            ? { lastApprovedSnapshotId: validation.snapshotId }
            : {}),
          version: deliverable.version + 1,
          updatedAt: now,
        })
        .where(and(eq(items.id, id), eq(items.version, deliverable.version)))
        .run();
      if (!changed.changes)
        throw new ConflictException('Deliverable changed during the decision');
      return tx
        .select()
        .from(validations)
        .where(eq(validations.id, validationId))
        .get();
    });
  }

  async review(
    projectId: string,
    resourceId: string,
    id: string,
    versionId: string,
    input: { action: 'validate' | 'reject'; version: number },
    reviewer: string,
  ) {
    const current = this.get(projectId, resourceId, id),
      version = this.getVersion(id, versionId);
    if (
      input.version !== current.version ||
      !['validate', 'reject'].includes(input.action)
    )
      throw new ConflictException('Invalid or outdated version review');
    if (input.action === 'validate')
      for (let index = 0; index < version.files.length; index++)
        await this.file(projectId, resourceId, id, versionId, index);
    return this.db.transaction((tx) => {
      if (
        !tx
          .update(items)
          .set({
            updatedByName: this.actor().name,
            status: input.action === 'validate' ? 'validated' : 'in_progress',
            ...(input.action === 'validate'
              ? { validatedVersionId: versionId }
              : {}),
            version: current.version + 1,
            updatedAt: Date.now(),
          })
          .where(and(eq(items.id, id), eq(items.version, current.version)))
          .run().changes
      )
        throw new ConflictException('Deliverable changed during review');
      if (version.status === 'validated' && input.action === 'reject')
        throw new ConflictException('A validated version cannot be rejected');
      tx.update(versions)
        .set({
          status: input.action === 'validate' ? 'validated' : 'rejected',
          reviewer,
          reviewedAt: Date.now(),
        })
        .where(eq(versions.id, versionId))
        .run();
      return this.get(projectId, resourceId, id);
    });
  }
}
