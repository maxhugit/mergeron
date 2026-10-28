import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ProjectWorkspaceLayout } from './project-workspace-layout';
import {
  WORKSPACE_LAYOUT_VERSION,
  projectSystemPath,
} from './workspace-structure';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { identityEvents } from '../auth/identity-events';
import {
  canReadProject,
  canReadThread,
  currentAccess,
  requireProjectAccess,
  requireThreadAccess,
  requireExecutionAccess,
} from '../auth/access-context';
import * as path from 'node:path';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projects,
  projectResources,
  projectTasks,
  projectTaskActivity,
  projectTaskDependencies,
  projectTaskStatuses,
  projectAgentThreads,
  projectWorkspaces,
  projectWorkspaceCopies,
  projectWorkspaceResources,
  simpleChatThreads,
  people,
  projectParticipants,
  projectManagerAssignments,
  projectPersonGroups,
  projectPersonGroupMembers,
  projectDeliverables,
  projectActivity,
  documentAccessSessions,
  type Project,
  type ProjectWorkspace,
  type ProjectResource,
  type ProjectTask,
  type ProjectTaskStatus,
} from '../database/schema';
import { FilesService } from '../files/files.service';
import { WorkspacesManagementService } from '../threads/workspaces-management.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { ThreadWorkspaceOverridesService } from '../threads/thread-workspace-overrides.service';
import { ThreadsDeletionService } from '../threads/threads-deletion.service';
import { ThreadsService } from '../threads/threads.service';
import { ProjectConnectionRuntimeService } from '../threads/project-connection-runtime.service';
import { SimpleChatService } from '../simple-chat/simple-chat.service';
import { WorkspaceTransfersService } from './workspace-transfers.service';
import {
  ActiveFoldersService,
  type ActiveFolderContext,
} from '../active-folders/active-folders.service';
import { summarizeProjects } from './project-dashboard';
import {
  PROJECT_REPLAN_SCHEMA,
  PROJECT_TASKS_SCHEMA,
  PROJECT_PLAN_SCHEMA,
  TASK_ADVICE_SCHEMA,
} from './project-ai-schemas';

const ORPHAN_ASSOCIATION_GRACE_MS = 5 * 60_000;
const REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

export type AutomationSchedule = 'manual' | 'daily' | 'weekly' | 'monthly';
export type ProjectAutomation = {
  id: string;
  name: string;
  instructions: string;
  schedule: AutomationSchedule;
  time: string;
  weekday: number;
  monthday: number;
  targetType: 'task_board' | 'workspace' | 'workspace_transfer';
  targetId: string;
  mode: 'analysis' | 'proposal' | 'action';
  approvalRequired: boolean;
  active: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type AutomationRun = {
  id: string;
  automationId: string;
  status:
    | 'running'
    | 'success'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'error';
  result: string;
  error: string;
  startedAt: number;
  finishedAt: number | null;
  transferRunId?: string | null;
};

export type ProjectActivityActor = {
  personId: string | null;
  name: string;
};

@Injectable()
export class ProjectsService implements OnModuleInit, OnModuleDestroy {
  private automationTimer?: NodeJS.Timeout;
  private readonly runningAutomationIds = new Set<string>();
  constructor(
    private readonly files: FilesService,
    private readonly workspaces: WorkspacesManagementService,
    private readonly metadata: ThreadMetadataService,
    private readonly overrides: ThreadWorkspaceOverridesService,
    private readonly deletion: ThreadsDeletionService,
    private readonly threads: ThreadsService,
    private readonly simpleChat: SimpleChatService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    @Optional() private readonly activeFolders?: ActiveFoldersService,
    @Optional() private readonly workspaceTransfers?: WorkspaceTransfersService,
    @Optional() private readonly connections?: ProjectConnectionRuntimeService,
  ) {}

  private get folders(): ActiveFoldersService {
    return this.activeFolders ?? new ActiveFoldersService(this.db);
  }

  async onModuleInit() {
    await this.ensurePrimaryWorkspaces();
    this.folders.migrateLegacyReferences();
    this.automationTimer = setInterval(
      () => void this.runDueAutomations(),
      60_000,
    );
    this.automationTimer.unref();
    void this.runDueAutomations();
  }

  onModuleDestroy() {
    if (this.automationTimer) clearInterval(this.automationTimer);
  }

  activity(projectId: string, limit = 200) {
    this.get(projectId);
    return (
      this.db
        .select()
        .from(projectActivity)
        // Restricted deliverable details are exposed only through the
        // deliverable board, which applies its own confidentiality checks.
        .where(
          and(
            eq(projectActivity.projectId, projectId),
            ne(projectActivity.entityType, 'deliverable_history'),
          ),
        )
        .orderBy(desc(projectActivity.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500))
        .all()
    );
  }

  setActiveFolder(
    projectId: string,
    contextType: ActiveFolderContext,
    contextId: string,
    input: { resourceId: string; relativePath?: string | null },
  ) {
    return this.folders.set(projectId, contextType, contextId, input);
  }

  recordActivity(
    projectId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    label: string,
    details: Record<string, unknown> = {},
    actor?: ProjectActivityActor,
  ) {
    this.db
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        action,
        entityType,
        entityId,
        label,
        details,
        actorPersonId: actor?.personId ?? null,
        actorName: actor?.name ?? 'Système',
        createdAt: Date.now(),
      })
      .run();
  }

  async configureMcpServers(
    projectId: string,
    names: unknown,
    actor?: ProjectActivityActor,
  ) {
    const project = this.get(projectId);
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
      throw new BadRequestException('Invalid MCP server selection');
    const stringNames = names as string[];
    const mcpServerIds = [
      ...new Set(stringNames.map((name) => name.trim()).filter(Boolean)),
    ];
    if (
      mcpServerIds.length > 100 ||
      mcpServerIds.some((name) => name.length > 120)
    )
      throw new BadRequestException('Invalid MCP server selection');
    const updatedAt = Date.now();
    if (JSON.stringify(mcpServerIds) === JSON.stringify(project.mcpServerIds))
      return project;
    const write = () =>
      this.db.transaction(() => {
        this.db
          .update(projects)
          .set({ mcpServerIds, updatedAt })
          .where(eq(projects.id, projectId))
          .run();
        this.recordActivity(
          projectId,
          'mcp_configuration_updated',
          'mcp',
          null,
          'Connecteurs MCP',
          { before: project.mcpServerIds, after: mcpServerIds },
          actor,
        );
        return { ...project, mcpServerIds, updatedAt };
      });
    return this.connections ? this.connections.change(write) : write();
  }

  async configureApps(
    projectId: string,
    ids: unknown,
    actor?: ProjectActivityActor,
  ) {
    const project = this.get(projectId);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw new BadRequestException('Invalid app selection');
    const stringIds = ids as string[];
    const appIds = [
      ...new Set(stringIds.map((id) => id.trim()).filter(Boolean)),
    ];
    if (appIds.length > 100 || appIds.some((id) => id.length > 160))
      throw new BadRequestException('Invalid app selection');
    const updatedAt = Date.now();
    if (JSON.stringify(appIds) === JSON.stringify(project.appIds))
      return project;
    const write = () =>
      this.db.transaction(() => {
        this.db
          .update(projects)
          .set({ appIds, updatedAt })
          .where(eq(projects.id, projectId))
          .run();
        this.recordActivity(
          projectId,
          'app_configuration_updated',
          'app',
          null,
          'Applications',
          { before: project.appIds, after: appIds },
          actor,
        );
        return { ...project, appIds, updatedAt };
      });
    return this.connections ? this.connections.change(write) : write();
  }

  configureBrowser(
    projectId: string,
    input: { homeUrl?: unknown; desktopSplit?: unknown; allowPopups?: unknown },
    actor?: ProjectActivityActor,
  ) {
    const project = this.get(projectId);
    let url: URL;
    try {
      if (typeof input.homeUrl !== 'string' || input.homeUrl.length > 4096)
        throw new Error();
      url = new URL(input.homeUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      throw new BadRequestException('Invalid browser home URL');
    }
    if (
      typeof input.desktopSplit !== 'boolean' ||
      typeof input.allowPopups !== 'boolean'
    )
      throw new BadRequestException('Invalid browser settings');
    const browserSettings = {
      homeUrl: url.href,
      desktopSplit: input.desktopSplit,
      allowPopups: input.allowPopups,
    };
    const updatedAt = Date.now();
    this.db.transaction(() => {
      this.db
        .update(projects)
        .set({ browserSettings, updatedAt })
        .where(eq(projects.id, projectId))
        .run();
      this.recordActivity(
        projectId,
        'browser_configuration_updated',
        'browser_configuration',
        null,
        'Navigateur',
        { before: project.browserSettings, after: browserSettings },
        actor,
      );
    });
    return { ...project, browserSettings, updatedAt };
  }

  configureAgent(
    projectId: string,
    input: { model?: unknown; reasoningEffort?: unknown },
    actor?: ProjectActivityActor,
  ) {
    const project = this.get(projectId);
    const model =
      typeof input.model === 'string' ? input.model.trim() || null : null;
    const reasoningEffort =
      typeof input.reasoningEffort === 'string'
        ? input.reasoningEffort.trim() || null
        : null;
    if (model && (model.length > 120 || !/^[a-zA-Z0-9._:-]+$/.test(model)))
      throw new BadRequestException('Invalid agent model');
    if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort))
      throw new BadRequestException('Invalid reasoning effort');
    const updatedAt = Date.now();
    this.db
      .update(projects)
      .set({
        agentModel: model,
        agentReasoningEffort: reasoningEffort,
        updatedAt,
      })
      .where(eq(projects.id, projectId))
      .run();
    this.recordActivity(
      projectId,
      'agent_configuration_updated',
      'agent_configuration',
      null,
      'Configuration des agents',
      {
        model: { before: project.agentModel, after: model },
        reasoningEffort: {
          before: project.agentReasoningEffort,
          after: reasoningEffort,
        },
      },
      actor,
    );
    return {
      ...project,
      agentModel: model,
      agentReasoningEffort: reasoningEffort,
      updatedAt,
    };
  }

  listPeople() {
    const access = currentAccess();
    const visibleIds =
      access && access.identity.role !== 'administrator'
        ? new Set(
            this.db
              .select()
              .from(projectParticipants)
              .all()
              .filter((p) => canReadProject(p.projectId))
              .map((p) => p.personId),
          )
        : null;
    return this.db
      .select()
      .from(people)
      .all()
      .filter(
        (person) =>
          !visibleIds ||
          visibleIds.has(person.id) ||
          person.id === access?.identity.personId,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  savePerson(
    input: {
      reference?: unknown;
      name?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      phone?: unknown;
      role?: unknown;
      email?: unknown;
      active?: unknown;
    },
    id?: string,
  ) {
    requireExecutionAccess();
    const existing = id
      ? this.db.select().from(people).where(eq(people.id, id)).get()
      : undefined;
    if (id && !existing) throw new NotFoundException('Person not found');
    const reference = this.validateTaskText(
      input.reference ?? existing?.reference,
      'Manual reference',
      80,
    );
    const firstName = this.validateTaskText(
      input.firstName ?? existing?.firstName,
      'First name',
      80,
    );
    const lastName = this.validateTaskText(
      input.lastName ?? existing?.lastName,
      'Last name',
      80,
    );
    const name = `${firstName} ${lastName}`;
    const phone = this.validateTaskText(
      input.phone ?? existing?.phone,
      'Phone number',
      40,
    );
    if (
      !/^\+?[0-9 ().-]{6,40}$/.test(phone) ||
      phone.replace(/\D/g, '').length < 8
    )
      throw new BadRequestException('Invalid phone number');
    const role = input.role ?? existing?.role ?? 'standard';
    if (role !== 'standard' && role !== 'administrator')
      throw new BadRequestException('Invalid platform role');
    const rawEmail = input.email !== undefined ? input.email : existing?.email;
    if (rawEmail != null && typeof rawEmail !== 'string')
      throw new BadRequestException('Invalid email');
    const email =
      typeof rawEmail === 'string'
        ? rawEmail.trim().toLowerCase() || null
        : null;
    if (!email) throw new BadRequestException('Email is required');
    if (
      email &&
      (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
      throw new BadRequestException('Invalid email');
    if (input.active !== undefined && typeof input.active !== 'boolean')
      throw new BadRequestException('Invalid active state');
    const all = this.listPeople();
    if (
      existing?.role === 'administrator' &&
      existing.active &&
      (role !== 'administrator' || input.active === false) &&
      !all.some(
        (p) =>
          p.id !== id &&
          p.active &&
          p.role === 'administrator' &&
          p.identitySubject,
      )
    )
      throw new BadRequestException(
        'The last active administrator cannot be disabled or demoted',
      );
    if (
      all.some(
        (p) =>
          p.id !== id && p.reference.toLowerCase() === reference.toLowerCase(),
      )
    )
      throw new ConflictException('Manual reference already exists');
    if (email && all.some((p) => p.id !== id && p.email === email))
      throw new ConflictException('Email already exists');
    const person = {
      id: existing?.id ?? randomUUID(),
      reference,
      name,
      email,
      firstName,
      lastName,
      phone,
      role,
      active:
        typeof input.active === 'boolean'
          ? input.active
          : (existing?.active ?? true),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    } satisfies typeof people.$inferInsert;
    const privilegesChanged =
      !!existing &&
      (existing.role !== person.role || existing.active !== person.active);
    this.db.transaction((tx) => {
      if (existing)
        tx.update(people).set(person).where(eq(people.id, existing.id)).run();
      else tx.insert(people).values(person).run();
      if (privilegesChanged)
        tx.delete(documentAccessSessions)
          .where(eq(documentAccessSessions.personId, person.id))
          .run();
    });
    if (privilegesChanged) identityEvents.emit('changed', person.id);
    return person;
  }

  participants(projectId: string) {
    this.get(projectId);
    const members = this.db
      .select()
      .from(projectParticipants)
      .where(eq(projectParticipants.projectId, projectId))
      .all();
    const resourceIds = new Set(
      this.db
        .select()
        .from(projectResources)
        .where(eq(projectResources.projectId, projectId))
        .all()
        .map((r) => r.id),
    );
    const tasks = this.db
      .select()
      .from(projectTasks)
      .all()
      .filter((task) => resourceIds.has(task.resourceId));
    const terminal = new Map(
      [...resourceIds].map((id) => [
        id,
        new Set(this.getTaskBoardTerminalSettings(id).taskStatusIds),
      ]),
    );
    return members.map((member) => ({
      ...member,
      assignmentCount: tasks.filter(
        (task) => task.assigneeId === member.personId,
      ).length,
      openAssignmentCount: tasks.filter(
        (task) =>
          task.assigneeId === member.personId &&
          (task.parentTaskId
            ? !['done', 'cancelled'].includes(task.subtaskStatus)
            : !terminal.get(task.resourceId)?.has(task.statusId)),
      ).length,
    }));
  }

  isParticipant(projectId: string, personId: string) {
    this.get(projectId);
    return !!this.db
      .select({ personId: projectParticipants.personId })
      .from(projectParticipants)
      .where(
        and(
          eq(projectParticipants.projectId, projectId),
          eq(projectParticipants.personId, personId),
        ),
      )
      .get();
  }

  addParticipant(projectId: string, personId: string) {
    requireExecutionAccess();
    this.get(projectId);
    if (typeof personId !== 'string' || !personId)
      throw new BadRequestException('Select an active person');
    const person = this.db
      .select()
      .from(people)
      .where(eq(people.id, personId))
      .get();
    if (!person?.active)
      throw new BadRequestException('Select an active person');
    this.db
      .insert(projectParticipants)
      .values({ projectId, personId, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
    return { ok: true };
  }

  removeParticipant(projectId: string, personId: string) {
    requireExecutionAccess();
    this.get(projectId);
    this.db.transaction((tx) => {
      const managedProject = tx
        .select()
        .from(projectManagerAssignments)
        .where(
          and(
            eq(projectManagerAssignments.projectId, projectId),
            eq(projectManagerAssignments.personId, personId),
          ),
        )
        .get();
      if (managedProject)
        tx.delete(projectManagerAssignments)
          .where(eq(projectManagerAssignments.projectId, projectId))
          .run();
      const groupIds = tx
        .select({ id: projectPersonGroups.id })
        .from(projectPersonGroups)
        .where(eq(projectPersonGroups.projectId, projectId))
        .all()
        .map((group) => group.id);
      for (const groupId of groupIds)
        tx.delete(projectPersonGroupMembers)
          .where(
            and(
              eq(projectPersonGroupMembers.groupId, groupId),
              eq(projectPersonGroupMembers.personId, personId),
            ),
          )
          .run();
      tx.delete(projectParticipants)
        .where(
          and(
            eq(projectParticipants.projectId, projectId),
            eq(projectParticipants.personId, personId),
          ),
        )
        .run();
      // Existing assignments are historical information and remain attached.
      tx.delete(documentAccessSessions)
        .where(
          and(
            eq(documentAccessSessions.projectId, projectId),
            eq(documentAccessSessions.personId, personId),
          ),
        )
        .run();
    });
    identityEvents.emit('changed', personId);
    return { ok: true };
  }

  peopleConfiguration(projectId: string) {
    this.get(projectId);
    const manager = this.db
      .select()
      .from(projectManagerAssignments)
      .where(eq(projectManagerAssignments.projectId, projectId))
      .get();
    const groups = this.db
      .select()
      .from(projectPersonGroups)
      .where(eq(projectPersonGroups.projectId, projectId))
      .all()
      .sort((a, b) => a.name.localeCompare(b.name));
    const groupIds = groups.map((group) => group.id);
    const memberships = groupIds.length
      ? this.db
          .select()
          .from(projectPersonGroupMembers)
          .where(inArray(projectPersonGroupMembers.groupId, groupIds))
          .all()
      : [];
    return {
      projectManagerPersonId: manager?.personId ?? null,
      groups: groups.map((group) => ({
        ...group,
        memberIds: memberships
          .filter((member) => member.groupId === group.id)
          .map((member) => member.personId),
      })),
    };
  }

  configureProjectManager(
    projectId: string,
    personId: unknown,
    actor?: ProjectActivityActor,
  ) {
    requireExecutionAccess();
    this.get(projectId);
    if (personId !== null && personId !== '')
      this.requireActiveParticipant(projectId, personId);
    const previous = this.db
      .select()
      .from(projectManagerAssignments)
      .where(eq(projectManagerAssignments.projectId, projectId))
      .get();
    const nextPersonId: string | null =
      typeof personId === 'string' && personId ? personId : null;
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.delete(projectManagerAssignments)
        .where(eq(projectManagerAssignments.projectId, projectId))
        .run();
      if (typeof nextPersonId === 'string')
        tx.insert(projectManagerAssignments)
          .values({
            projectId,
            personId: nextPersonId,
            createdAt: now,
            updatedAt: now,
          })
          .run();
    });
    this.recordActivity(
      projectId,
      'project_manager_updated',
      'project_manager',
      nextPersonId,
      'Chef de projet',
      { before: previous?.personId ?? null, after: nextPersonId },
      actor,
    );
    return this.peopleConfiguration(projectId);
  }

  savePersonGroup(
    projectId: string,
    input: { name?: unknown; memberIds?: unknown },
    groupId?: string,
    actor?: ProjectActivityActor,
  ) {
    requireExecutionAccess();
    this.get(projectId);
    const existing = groupId
      ? this.db
          .select()
          .from(projectPersonGroups)
          .where(
            and(
              eq(projectPersonGroups.id, groupId),
              eq(projectPersonGroups.projectId, projectId),
            ),
          )
          .get()
      : undefined;
    if (groupId && !existing) throw new NotFoundException('Group not found');
    const name = this.validateTaskText(
      input.name ?? existing?.name,
      'Group name',
      80,
    );
    const duplicate = this.db
      .select()
      .from(projectPersonGroups)
      .where(eq(projectPersonGroups.projectId, projectId))
      .all()
      .some(
        (group) =>
          group.id !== groupId &&
          group.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
    if (duplicate) throw new ConflictException('Group name already exists');
    if (!Array.isArray(input.memberIds))
      throw new BadRequestException('Invalid group members');
    if (
      input.memberIds.some((id) => typeof id !== 'string') ||
      input.memberIds.length > 500
    )
      throw new BadRequestException('Invalid group members');
    const memberIds = [...new Set(input.memberIds as string[])];
    for (const memberId of memberIds)
      this.requireActiveParticipant(projectId, memberId);
    const id = existing?.id ?? randomUUID();
    const now = Date.now();
    this.db.transaction((tx) => {
      if (existing)
        tx.update(projectPersonGroups)
          .set({ name, updatedAt: now })
          .where(eq(projectPersonGroups.id, id))
          .run();
      else
        tx.insert(projectPersonGroups)
          .values({ id, projectId, name, createdAt: now, updatedAt: now })
          .run();
      tx.delete(projectPersonGroupMembers)
        .where(eq(projectPersonGroupMembers.groupId, id))
        .run();
      for (const personId of memberIds)
        tx.insert(projectPersonGroupMembers)
          .values({ groupId: id, personId, createdAt: now })
          .run();
    });
    this.recordActivity(
      projectId,
      existing ? 'person_group_updated' : 'person_group_created',
      'person_group',
      id,
      name,
      { memberIds },
      actor,
    );
    return this.peopleConfiguration(projectId);
  }

  deletePersonGroup(
    projectId: string,
    groupId: string,
    actor?: ProjectActivityActor,
  ) {
    requireExecutionAccess();
    this.get(projectId);
    const group = this.db
      .select()
      .from(projectPersonGroups)
      .where(
        and(
          eq(projectPersonGroups.id, groupId),
          eq(projectPersonGroups.projectId, projectId),
        ),
      )
      .get();
    if (!group) throw new NotFoundException('Group not found');
    this.db
      .delete(projectPersonGroups)
      .where(eq(projectPersonGroups.id, groupId))
      .run();
    const affected = this.db
      .select({
        id: projectDeliverables.id,
        groupIds: projectDeliverables.authorizedGroupIds,
      })
      .from(projectDeliverables)
      .innerJoin(
        projectResources,
        eq(projectDeliverables.resourceId, projectResources.id),
      )
      .where(eq(projectResources.projectId, projectId))
      .all()
      .filter((deliverable) => deliverable.groupIds.includes(groupId));
    for (const deliverable of affected) {
      const groupIds = deliverable.groupIds.filter((id) => id !== groupId);
      this.db
        .update(projectDeliverables)
        .set({
          authorizedGroupIds: groupIds,
          ...(groupIds.length ? {} : { confidentiality: 'standard' as const }),
          updatedAt: Date.now(),
        })
        .where(eq(projectDeliverables.id, deliverable.id))
        .run();
    }
    this.recordActivity(
      projectId,
      'person_group_deleted',
      'person_group',
      groupId,
      group.name,
      {},
      actor,
    );
    return { ok: true };
  }

  private requireActiveParticipant(projectId: string, personId: unknown) {
    if (typeof personId !== 'string' || !personId)
      throw new BadRequestException('Select an active project participant');
    const person = this.db
      .select()
      .from(people)
      .where(eq(people.id, personId))
      .get();
    if (!person?.active || !this.isParticipant(projectId, personId))
      throw new BadRequestException('Select an active project participant');
    return person;
  }

  private validateAssignee(projectId: string, id: unknown): string | null {
    if (id === null || id === '') return null;
    if (typeof id !== 'string')
      throw new BadRequestException('Invalid responsible person');
    const person = this.db.select().from(people).where(eq(people.id, id)).get();
    const member = this.db
      .select()
      .from(projectParticipants)
      .where(
        and(
          eq(projectParticipants.projectId, projectId),
          eq(projectParticipants.personId, id),
        ),
      )
      .get();
    if (!person?.active || !member)
      throw new BadRequestException(
        'The responsible person must be an active project participant',
      );
    return id;
  }

  private assigneeLabel(id: string | null) {
    if (!id) return null;
    const person = this.db.select().from(people).where(eq(people.id, id)).get();
    return person ? `${person.name} (${person.reference})` : id;
  }

  async dashboard() {
    const agents = this.db.select().from(projectAgentThreads).all();
    const chats = this.db.select().from(simpleChatThreads).all();
    const snapshot = await this.metadata.read().catch(() => null);
    const updated = new Map(
      (snapshot?.entries ?? []).map((entry) => [
        entry.thread.id,
        entry.thread.updatedAt < 1_000_000_000_000
          ? entry.thread.updatedAt * 1000
          : entry.thread.updatedAt,
      ]),
    );
    return summarizeProjects({
      projects: this.db
        .select()
        .from(projects)
        .all()
        .filter((p) => canReadProject(p.id)),
      resources: this.db
        .select()
        .from(projectResources)
        .all()
        .filter((r) => canReadProject(r.projectId)),
      tasks: this.db
        .select()
        .from(projectTasks)
        .all()
        .filter((t) => {
          const resource = this.db
            .select()
            .from(projectResources)
            .where(eq(projectResources.id, t.resourceId))
            .get();
          return !!resource && canReadProject(resource.projectId);
        }),
      statuses: this.db.select().from(projectTaskStatuses).all(),
      activity: [
        ...agents.map((a) => ({
          projectId: a.projectId,
          updatedAt: Math.max(a.updatedAt, updated.get(a.threadId) ?? 0),
        })),
        ...chats
          .filter((c) => c.projectId)
          .map((c) => ({ projectId: c.projectId!, updatedAt: c.updatedAt })),
      ],
    });
  }

  async list(): Promise<
    Array<
      Project & {
        systemWorkspacePath?: string;
        workspaces: Array<
          ProjectWorkspace & {
            readOnly: boolean;
            sourceResourceId: string | null;
            branch: string | null;
            revision: string | null;
          }
        >;
        resources: ProjectResource[];
        agentThreads: Array<{
          threadId: string;
          workspacePath: string;
          activeFolder: ReturnType<ActiveFoldersService['get']>;
          title: string;
          archived: boolean;
          taskId: string | null;
          taskResourceId: string | null;
          taskTitle: string | null;
          isSubtask: boolean;
        }>;
      }
    >
  > {
    await this.ensurePrimaryWorkspaces();
    const workspaces = this.db.select().from(projectWorkspaces).all();
    const workspaceCopies = this.db.select().from(projectWorkspaceCopies).all();
    const workspaceResources = this.db
      .select()
      .from(projectWorkspaceResources)
      .all();
    const resources = this.db.select().from(projectResources).all();
    const tasks = this.db.select().from(projectTasks).all();
    const agents = this.db.select().from(projectAgentThreads).all();
    const snapshot = await this.metadata.read().catch(() => null);
    const snapshotEntries = snapshot?.entries ?? [];
    const effectiveThreads = this.overrides.applyToThreads(
      snapshotEntries.map((entry) => entry.thread),
    );
    const threadMetadata = new Map(
      snapshotEntries.map((entry, index) => [
        entry.thread.id,
        { thread: effectiveThreads[index], archived: entry.archived },
      ]),
    );
    // Active folders are explicit choices. Upstream cwd observations never
    // rewrite them: a running turn retains the snapshot it started with.
    // Codex does not expose empty placeholders as conversations. Keep a short
    // grace period for a freshly-created agent, then discard only its WebUI
    // association when it never became visible or was deleted elsewhere.
    if (snapshot) {
      const orphanCutoff = Date.now() - ORPHAN_ASSOCIATION_GRACE_MS;
      for (const agent of agents)
        if (
          !threadMetadata.has(agent.threadId) &&
          agent.updatedAt < orphanCutoff
        )
          this.db
            .delete(projectAgentThreads)
            .where(eq(projectAgentThreads.threadId, agent.threadId))
            .run();
    }
    return this.db
      .select()
      .from(projects)
      .all()
      .filter((p) => canReadProject(p.id))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
      .map((project) => ({
        ...project,
        ...(project.workspaceLayoutVersion >= 3 &&
        (!currentAccess() || currentAccess()?.identity.role === 'administrator')
          ? { systemWorkspacePath: projectSystemPath(project.workspacePath) }
          : {}),
        workspaces: workspaces
          .filter((workspace) => workspace.projectId === project.id)
          .map((workspace) => {
            const copy = workspaceCopies.find(
              (item) => item.localWorkspaceId === workspace.id,
            );
            const source = copy
              ? workspaceResources.find(
                  (item) => item.id === copy.sourceResourceId,
                )
              : null;
            return {
              ...workspace,
              readOnly: copy ? source?.accessMode !== 'read_write' : false,
              sourceResourceId: copy?.sourceResourceId ?? null,
              branch: copy?.branch ?? null,
              revision: copy?.revision ?? null,
            };
          })
          .sort((a, b) => Number(b.primary) - Number(a.primary)),
        resources: resources.filter(
          (resource) =>
            resource.projectId === project.id &&
            resource.config.internal !== true,
        ),
        agentThreads: agents
          .filter(
            (agent) =>
              agent.projectId === project.id &&
              canReadThread(agent.threadId) &&
              threadMetadata.has(agent.threadId),
          )
          .map(({ threadId, workspacePath }) => {
            const metadata = threadMetadata.get(threadId)!;
            const task = tasks.find(
              (candidate) => candidate.linkedThreadId === threadId,
            );
            return {
              threadId,
              workspacePath,
              activeFolder: this.folders.get('agent', threadId),
              title:
                metadata.thread.name?.trim() || metadata.thread.preview.trim(),
              archived: metadata.archived,
              taskId: task?.id ?? null,
              taskResourceId: task?.resourceId ?? null,
              taskTitle: task?.title ?? null,
              isSubtask: Boolean(task?.parentTaskId),
            };
          }),
      }));
  }

  /** Complete project membership before returning a newly created conversation. */
  async createAgent(projectId: string, workspacePath: string) {
    requireExecutionAccess();
    const folder = this.folders.validateAbsoluteSelection(
      projectId,
      workspacePath,
    );
    if (!folder.effectivePath)
      throw new ConflictException('Active folder is unresolved');
    const response = await this.threads.startThread({
      cwd: folder.effectivePath,
    });
    try {
      // No rollout exists before the first turn: do not resume a fresh thread.
      await this.associateAgent(
        projectId,
        response.thread.id,
        workspacePath,
        true,
      );
      this.metadata.invalidate();
      return response;
    } catch (error) {
      await this.threads.archiveThread(response.thread.id).catch(() => {});
      throw error;
    }
  }

  async associateAgent(
    projectId: string,
    threadId: string,
    selection:
      | string
      | { resourceId: string; relativePath?: string | null }
      | { locationId: string; relativePath?: string | null },
    alreadyAtWorkspace = false,
  ) {
    requireExecutionAccess();
    requireThreadAccess(threadId);
    const existing = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    if (existing && existing.projectId !== projectId)
      throw new ConflictException(
        'Conversations cannot be moved between projects',
      );
    const folder =
      typeof selection === 'string'
        ? this.folders.validateAbsoluteSelection(projectId, selection)
        : 'locationId' in selection
          ? this.folders.validateLocationSelection(projectId, selection)
          : this.folders.validateSelection(projectId, selection);
    if (!folder.effectivePath)
      throw new ConflictException('Active folder is unresolved');
    const workspace = this.getWorkspace(projectId, folder.resourceId);
    if (!workspace) throw new NotFoundException('Project resource not found');
    this.folders.reserveAgentCopy(projectId, threadId, folder.effectivePath);
    const threadIds = alreadyAtWorkspace
      ? this.threads.rememberInitialThreadCwd(threadId, folder.effectivePath)
      : await this.threads.setThreadCwd(threadId, folder.effectivePath);
    const now = Date.now();
    this.db.transaction((tx) => {
      for (const id of threadIds)
        tx.insert(projectAgentThreads)
          .values({
            threadId: id,
            projectId,
            workspacePath: workspace.path,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: projectAgentThreads.threadId,
            set: { projectId, workspacePath: workspace.path, updatedAt: now },
          })
          .run();
    });
    for (const id of threadIds)
      this.folders.set(projectId, 'agent', id, {
        resourceId: folder.resourceId,
        relativePath: folder.relativePath,
      });
    return {
      threadIds,
      projectId,
      workspacePath: folder.effectivePath,
      activeFolder: this.folders.get('agent', threadId),
    };
  }

  setDefaultWorkspace(projectId: string, workspaceId: string) {
    this.get(projectId);
    const selected = this.db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, workspaceId),
          eq(projectWorkspaces.projectId, projectId),
        ),
      )
      .get();
    if (!selected) throw new NotFoundException('Workspace not found');
    if (!selected.primary)
      throw new ConflictException(
        'The primary workspace is permanent. Select the active workspace in the conversation instead.',
      );
    return selected;
  }

  detachWorkspace(projectId: string, workspaceId: string) {
    this.get(projectId);
    const workspace = this.db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, workspaceId),
          eq(projectWorkspaces.projectId, projectId),
        ),
      )
      .get();
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (workspace.primary)
      throw new ConflictException(
        'The primary workspace can only be removed with its project',
      );
    this.db
      .delete(projectWorkspaces)
      .where(eq(projectWorkspaces.id, workspaceId))
      .run();
    return {
      ok: true,
      preservedPath: workspace.path,
      activeReferencesPreserved: true,
    };
  }

  /** Reports missing resources without rewriting active-folder choices. */
  async reconcileMissingWorkspaces(): Promise<{
    removed: string[];
    reassignedAgents: number;
    reassignedSimpleChats: number;
    unresolved: string[];
  }> {
    const removed: string[] = [];
    const unresolved: string[] = [];
    const reassignedAgents = 0;
    const reassignedSimpleChats = 0;
    for (const project of this.db.select().from(projects).all()) {
      const attached = this.db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, project.id))
        .all();
      const missing: ProjectWorkspace[] = [];
      for (const workspace of attached) {
        if (!(await this.files.directoryExists(workspace.path)))
          missing.push(workspace);
      }
      unresolved.push(...missing.map((workspace) => workspace.path));
    }
    return {
      removed,
      reassignedAgents,
      reassignedSimpleChats,
      unresolved,
    };
  }

  async create(
    nameValue: string,
    workspacePathValue?: string,
  ): Promise<Project> {
    const name = this.validateName(nameValue);
    if (workspacePathValue?.trim())
      throw new BadRequestException(
        'The primary workspace path is generated from the project ID. Attach other folders as secondary workspaces.',
      );
    const id = randomUUID();
    const workspacePath = await new ProjectWorkspaceLayout(this.db).prepare(id);
    const now = Date.now();
    const project: Project = {
      id,
      name,
      workspacePath,
      workspaceLayoutVersion: WORKSPACE_LAYOUT_VERSION,
      mcpServerIds: [],
      appIds: [],
      agentModel: null,
      agentReasoningEffort: null,
      browserSettings: {
        homeUrl: 'https://www.google.com',
        desktopSplit: true,
        allowPopups: true,
      },
      sidebarOrder: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db.transaction((tx) => {
        tx.insert(projects).values(project).run();
        const personId = currentAccess()?.identity.personId;
        if (personId)
          tx.insert(projectParticipants)
            .values({ projectId: id, personId, createdAt: now })
            .run();
        tx.insert(projectWorkspaces)
          .values({
            id: randomUUID(),
            projectId: project.id,
            name: 'Principal',
            path: workspacePath,
            primary: true,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      });
      return project;
    } catch (error) {
      await this.cleanupNewProjectDirectory(workspacePath);
      throw error;
    }
  }

  private async cleanupNewProjectDirectory(
    workspacePath: string,
  ): Promise<void> {
    // The managed cleanup intentionally only accepts a direct child of
    // /workspaces. For a custom path we leave an empty directory behind on the
    // extremely rare database failure rather than risk deleting user data.
    await this.files.deleteManagedWorkspace(workspacePath).catch(() => {});
  }

  async createWorkspace(
    projectId: string,
    input: { name?: string; path?: string },
  ): Promise<ProjectWorkspace> {
    this.get(projectId);
    const requestedPath = input.path?.trim();
    const name = this.validateName(
      input.name ?? (requestedPath ? path.basename(requestedPath) : ''),
    );
    // A workspace is an independent execution context. It is deliberately not
    // nested below the project's primary workspace: projects group contexts,
    // they do not own a filesystem subtree.
    const workspacePath = requestedPath
      ? await this.files.resolveSafePath(requestedPath)
      : path.join('/workspaces', name);
    this.files.assertProjectPathMutable(workspacePath);
    const canonical = path.resolve(workspacePath);
    const existingPaths = [
      ...this.db
        .select()
        .from(projectWorkspaces)
        .all()
        .map((w) => w.path),
      ...this.db
        .select()
        .from(projects)
        .all()
        .map((p) => p.workspacePath),
    ];
    for (const root of existingPaths) {
      let existingRoot = path.resolve(root);
      try {
        existingRoot = realpathSync(existingRoot);
      } catch {
        /* Missing paths retain their reserved location. */
      }
      if (
        canonical === existingRoot ||
        canonical.startsWith(existingRoot + path.sep) ||
        existingRoot.startsWith(canonical + path.sep)
      )
        throw new ConflictException('Project workspaces cannot overlap');
    }
    const existing = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.path, workspacePath))
      .get();
    if (existing)
      throw new ConflictException(
        'This directory is already attached to a project',
      );

    let createdDirectory = false;
    if (requestedPath) {
      // Also validates that the selected safe path is a directory.
      await this.files.readDirectory(workspacePath);
    } else {
      await this.files.createDirectory(workspacePath, false, false);
      createdDirectory = true;
    }
    const now = Date.now();
    const workspace: ProjectWorkspace = {
      id: randomUUID(),
      projectId,
      name,
      path: workspacePath,
      primary: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db.insert(projectWorkspaces).values(workspace).run();
      return workspace;
    } catch (error) {
      if (createdDirectory)
        await this.files.deleteManagedWorkspace(workspacePath).catch(() => {});
      throw error;
    }
  }

  createResource(
    projectId: string,
    input: { type: string; name?: string },
  ): ProjectResource {
    this.get(projectId);
    if (
      !['task_board', 'automation_board', 'deliverable_board'].includes(
        input.type,
      )
    )
      throw new BadRequestException('Unsupported project resource type');
    const siblings = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, input.type),
        ),
      )
      .all()
      .filter((resource) => resource.config.internal !== true);
    if (input.type !== 'task_board' && siblings.length) return siblings[0];
    const label =
      input.type === 'deliverable_board'
        ? 'Gestion des livrables'
        : input.type === 'automation_board'
          ? 'Automatisations'
          : 'Gestionnaire de tâches';
    const defaultName =
      siblings.length === 0 ? label : `${label} ${siblings.length + 1}`;
    const name = input.name?.trim() || defaultName;
    if (name.length > 120)
      throw new BadRequestException('Resource name is too long');
    const now = Date.now();
    const resource: ProjectResource = {
      id: randomUUID(),
      projectId,
      type: input.type,
      name,
      config:
        input.type === 'automation_board' ? { automations: [], runs: [] } : {},
      createdAt: now,
      updatedAt: now,
    };
    const defaultStatuses = [
      {
        name: 'Actions non assignées',
        color: 'slate',
        kind: 'unassigned',
        system: true,
      },
      { name: 'À faire', color: 'blue', kind: 'todo', system: false },
      { name: 'En cours', color: 'amber', kind: 'in_progress', system: false },
      { name: 'Bloqué', color: 'red', kind: 'blocked', system: false },
      { name: 'À valider', color: 'purple', kind: 'review', system: false },
      { name: 'Terminé', color: 'green', kind: 'done', system: false },
    ];
    this.db.transaction((tx) => {
      tx.insert(projectResources).values(resource).run();
      if (input.type !== 'task_board') return;
      tx.insert(projectTaskStatuses)
        .values(
          defaultStatuses.map((status, position) => ({
            id: randomUUID(),
            resourceId: resource.id,
            ...status,
            position,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
    });
    return resource;
  }

  createDeliverableExecutionSubtask(
    projectId: string,
    deliverableId: string,
    title: string,
    criteria: string,
    actor?: ProjectActivityActor,
    subtaskTitle?: string,
  ): ProjectTask {
    const marker = `mergeron:deliverable:${deliverableId}`;
    let resource = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.projectId, projectId),
          eq(projectResources.type, 'task_board'),
        ),
      )
      .all()
      .find(
        (candidate) =>
          candidate.config.internal === true &&
          candidate.config.purpose === 'deliverable_execution',
      );
    if (!resource) {
      resource = this.createResource(projectId, {
        type: 'task_board',
        name: 'Exécutions internes des livrables',
      });
      resource = {
        ...resource,
        config: { internal: true, purpose: 'deliverable_execution' },
      };
      this.db
        .update(projectResources)
        .set({ config: resource.config, updatedAt: Date.now() })
        .where(eq(projectResources.id, resource.id))
        .run();
    }
    let parent = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.resourceId, resource.id))
      .all()
      .find((task) => !task.parentTaskId && task.labels.includes(marker));
    if (!parent)
      parent = this.createTask(
        projectId,
        resource.id,
        {
          title: `Livrable — ${title}`,
          description:
            'Unité interne créée automatiquement pour organiser les agents de ce livrable.',
          labels: [marker],
          validationCriteria: criteria,
        },
        actor,
      );
    return this.createTask(
      projectId,
      resource.id,
      {
        parentTaskId: parent.id,
        title: subtaskTitle?.trim() || `Produire — ${title}`,
        description: `Produire le livrable « ${title} » depuis cette unité d’exécution.`,
        validationCriteria: criteria,
        executionMode: 'agent',
      },
      actor,
    );
  }

  async readResource(projectId: string, resourceId: string) {
    const resource = this.getResource(projectId, resourceId);
    if (resource.type === 'deliverable_board')
      return { resource, project: this.get(projectId) };
    if (resource.type === 'automation_board')
      return {
        resource,
        project: this.get(projectId),
        workspaces: this.db
          .select()
          .from(projectWorkspaces)
          .where(eq(projectWorkspaces.projectId, projectId))
          .all(),
        targets: this.db
          .select()
          .from(projectResources)
          .where(eq(projectResources.projectId, projectId))
          .all()
          .filter((item) => item.type === 'task_board'),
        transfers: this.workspaceTransfers?.list(projectId).transfers ?? [],
        ...this.automationConfig(resource),
      };
    return this.readTaskBoard(projectId, resourceId);
  }

  async readTaskBoard(projectId: string, resourceId: string) {
    const resource = this.getResource(projectId, resourceId);
    const project = this.get(projectId);
    // "À valider" used to be protected while top-level tasks could run an
    // agent. Agents now belong exclusively to subtasks, so existing boards
    // must expose this legacy column as a regular, removable status.
    const legacyReviewStatus = this.db
      .select()
      .from(projectTaskStatuses)
      .where(eq(projectTaskStatuses.resourceId, resourceId))
      .all()
      .find((status) => status.kind === 'review' && status.system);
    if (legacyReviewStatus)
      this.db
        .update(projectTaskStatuses)
        .set({ system: false, updatedAt: Date.now() })
        .where(eq(projectTaskStatuses.id, legacyReviewStatus.id))
        .run();
    const workspaces = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .all();
    await this.syncAgentStates(resourceId);
    this.recalculateAllParentEstimates(resourceId);
    const tasks = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.resourceId, resourceId))
      .all()
      .sort((a, b) => a.position - b.position);
    const taskIds = new Set(tasks.map((task) => task.id));
    return {
      resource,
      project,
      workspaces,
      statuses: this.db
        .select()
        .from(projectTaskStatuses)
        .where(eq(projectTaskStatuses.resourceId, resourceId))
        .all()
        .sort((a, b) => a.position - b.position),
      tasks: tasks.map((task) => ({
        ...task,
        activeFolder: this.folders.get('task', task.id),
      })),
      activity: this.db
        .select()
        .from(projectTaskActivity)
        .where(eq(projectTaskActivity.resourceId, resourceId))
        .all()
        .sort((a, b) => b.createdAt - a.createdAt),
      dependencies: this.db
        .select()
        .from(projectTaskDependencies)
        .all()
        .filter(
          (dependency) =>
            taskIds.has(dependency.taskId) &&
            taskIds.has(dependency.dependsOnTaskId),
        ),
    };
  }

  createTaskStatus(
    projectId: string,
    resourceId: string,
    input: { name?: string; color?: string },
  ): ProjectTaskStatus {
    this.getResource(projectId, resourceId);
    const name = this.validateTaskText(input.name, 'Status name', 80);
    const statuses = this.db
      .select()
      .from(projectTaskStatuses)
      .where(eq(projectTaskStatuses.resourceId, resourceId))
      .all();
    const now = Date.now();
    const status: ProjectTaskStatus = {
      id: randomUUID(),
      resourceId,
      name,
      color: this.validateColor(input.color),
      kind: 'custom',
      position: Math.max(-1, ...statuses.map((item) => item.position)) + 1,
      system: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(projectTaskStatuses).values(status).run();
    return status;
  }

  updateTaskStatus(
    projectId: string,
    resourceId: string,
    statusId: string,
    input: { name?: string; color?: string; position?: number },
  ): ProjectTaskStatus {
    this.getResource(projectId, resourceId);
    const status = this.requireTaskStatus(resourceId, statusId);
    const updated: ProjectTaskStatus = {
      ...status,
      name:
        input.name === undefined
          ? status.name
          : this.validateTaskText(input.name, 'Status name', 80),
      color:
        input.color === undefined
          ? status.color
          : this.validateColor(input.color),
      position:
        typeof input.position === 'number' && Number.isInteger(input.position)
          ? Math.max(0, input.position)
          : status.position,
      updatedAt: Date.now(),
    };
    this.db
      .update(projectTaskStatuses)
      .set(updated)
      .where(eq(projectTaskStatuses.id, statusId))
      .run();
    return updated;
  }

  deleteTaskStatus(projectId: string, resourceId: string, statusId: string) {
    this.getResource(projectId, resourceId);
    const status = this.requireTaskStatus(resourceId, statusId);
    if (status.system)
      throw new ConflictException('System task statuses cannot be deleted');
    const fallback = this.db
      .select()
      .from(projectTaskStatuses)
      .where(eq(projectTaskStatuses.resourceId, resourceId))
      .all()
      .find((item) => item.kind === 'unassigned');
    if (!fallback) throw new ConflictException('Unassigned status is missing');
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.update(projectTasks)
        .set({ statusId: fallback.id, updatedAt: now })
        .where(eq(projectTasks.statusId, status.id))
        .run();
      tx.delete(projectTaskStatuses)
        .where(eq(projectTaskStatuses.id, status.id))
        .run();
    });
    return { ok: true, fallbackStatusId: fallback.id };
  }

  createTask(
    projectId: string,
    resourceId: string,
    input: {
      assigneeId?: string | null;
      title?: string;
      description?: string;
      priority?: string;
      dueAt?: number | null;
      labels?: string[];
      linkedFilePath?: string | null;
      parentTaskId?: string | null;
      workspacePath?: string | null;
      executionMode?: string;
      estimateMinutes?: number;
      progress?: number;
      startAt?: number | null;
      validationCriteria?: string;
      dependencyIds?: string[];
      subtaskStatus?: string;
    },
    actor?: ProjectActivityActor,
  ): ProjectTask {
    this.getResource(projectId, resourceId);
    const fallback = this.db
      .select()
      .from(projectTaskStatuses)
      .where(eq(projectTaskStatuses.resourceId, resourceId))
      .all()
      .find((item) => item.kind === 'unassigned');
    if (!fallback) throw new ConflictException('Unassigned status is missing');
    const tasks = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.statusId, fallback.id))
      .all();
    const priorities = this.getTaskPriorities(resourceId);
    if (input.priority && !priorities.has(input.priority))
      throw new BadRequestException('Invalid priority');
    const parent = input.parentTaskId
      ? this.requireTask(resourceId, input.parentTaskId)
      : null;
    if (parent?.parentTaskId)
      throw new BadRequestException('A subtask cannot contain subtasks');
    const now = Date.now();
    const task: ProjectTask = {
      id: randomUUID(),
      resourceId,
      statusId: parent?.statusId ?? fallback.id,
      assigneeId: this.validateAssignee(projectId, input.assigneeId ?? null),
      title: this.validateTaskText(input.title, 'Task title', 200),
      description: input.description?.trim().slice(0, 10_000) ?? '',
      priority: parent ? parent.priority : (input.priority ?? 'normal'),
      parentTaskId: input.parentTaskId ?? null,
      subtaskStatus: 'todo',
      workspacePath: parent
        ? parent.workspacePath
        : this.validateTaskWorkspace(projectId, input.workspacePath),
      executionMode:
        parent && input.executionMode === 'agent' ? 'agent' : 'manual',
      agentState:
        parent && input.executionMode === 'agent' ? 'ready' : 'manual',
      estimateMinutes: Math.max(0, Math.trunc(input.estimateMinutes ?? 0)),
      progress: Math.min(100, Math.max(0, Math.trunc(input.progress ?? 0))),
      startAt: input.startAt ?? null,
      dueAt: input.dueAt ?? null,
      validationCriteria:
        input.validationCriteria?.trim().slice(0, 10_000) ?? '',
      labels: (input.labels ?? [])
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, 20),
      linkedThreadId: null,
      linkedSimpleChatId: null,
      linkedFilePath: parent ? null : input.linkedFilePath?.trim() || null,
      position: Math.max(-1, ...tasks.map((item) => item.position)) + 1,
      createdAt: now,
      updatedAt: now,
    };
    this.validateTaskDateRange(task.startAt, task.dueAt, parent);
    this.db.transaction((tx) => {
      tx.insert(projectTasks).values(task).run();
      tx.insert(projectTaskActivity)
        .values({
          id: randomUUID(),
          resourceId,
          taskId: task.id,
          taskTitle: task.title,
          parentTaskId: task.parentTaskId,
          action: 'created',
          changes: task.assigneeId
            ? {
                assigneeId: {
                  before: null,
                  after: this.assigneeLabel(task.assigneeId),
                },
              }
            : {},
          actorPersonId: actor?.personId ?? null,
          actorName: actor?.name ?? 'Système',
          createdAt: now,
        })
        .run();
      for (const dependencyId of this.validateDependencyIds(
        resourceId,
        task.id,
        parent ? [] : input.dependencyIds,
      ))
        tx.insert(projectTaskDependencies)
          .values({
            taskId: task.id,
            dependsOnTaskId: dependencyId,
            createdAt: now,
          })
          .run();
    });
    if (task.parentTaskId)
      this.recalculateParentEstimate(
        resourceId,
        task.parentTaskId,
        true,
        actor,
      );
    this.folders.setFromAbsolutePath(
      projectId,
      'task',
      task.id,
      task.workspacePath,
    );
    return task;
  }

  async updateTask(
    projectId: string,
    resourceId: string,
    taskId: string,
    input: Partial<{
      assigneeId: string | null;
      title: string;
      description: string;
      priority: string;
      dueAt: number | null;
      labels: string[];
      statusId: string;
      position: number;
      linkedThreadId: string | null;
      linkedSimpleChatId: string | null;
      linkedFilePath: string | null;
      parentTaskId: string | null;
      workspacePath: string | null;
      executionMode: string;
      agentState: string;
      estimateMinutes: number;
      progress: number;
      startAt: number | null;
      validationCriteria: string;
      dependencyIds: string[];
      subtaskStatus: string;
    }>,
    actor?: ProjectActivityActor,
  ): Promise<ProjectTask> {
    this.getResource(projectId, resourceId);
    const task = this.requireTask(resourceId, taskId);
    if (input.assigneeId !== undefined && input.assigneeId !== task.assigneeId)
      this.validateAssignee(projectId, input.assigneeId);
    if (input.statusId) this.requireTaskStatus(resourceId, input.statusId);
    if (input.parentTaskId) {
      if (input.parentTaskId === task.id)
        throw new BadRequestException('A task cannot be its own parent');
      const parent = this.requireTask(resourceId, input.parentTaskId);
      if (parent.parentTaskId)
        throw new BadRequestException('A subtask cannot contain subtasks');
    }
    const effectiveParentId =
      input.parentTaskId !== undefined ? input.parentTaskId : task.parentTaskId;
    const effectiveParent = effectiveParentId
      ? this.requireTask(resourceId, effectiveParentId)
      : null;
    const hasChildren =
      !effectiveParentId &&
      this.db
        .select({ id: projectTasks.id })
        .from(projectTasks)
        .where(eq(projectTasks.parentTaskId, task.id))
        .all().length > 0;
    if (input.executionMode === 'agent' && !effectiveParentId)
      throw new BadRequestException(
        'Only subtasks can be assigned to an agent',
      );
    const subtaskStatuses = new Set([
      'todo',
      'started',
      'review',
      'done',
      'cancelled',
    ]);
    if (
      input.subtaskStatus !== undefined &&
      (!effectiveParentId || !subtaskStatuses.has(input.subtaskStatus))
    )
      throw new BadRequestException('Invalid subtask status');
    if (effectiveParentId && input.dependencyIds?.length)
      throw new BadRequestException('Subtasks cannot have dependencies');
    if (input.statusId) {
      const requestedStatus = this.requireTaskStatus(
        resourceId,
        input.statusId,
      );
      const terminalSettings = this.getTaskBoardTerminalSettings(resourceId);
      if (
        !effectiveParentId &&
        terminalSettings.taskStatusIds.includes(requestedStatus.id)
      ) {
        const unfinished = this.db
          .select()
          .from(projectTasks)
          .where(eq(projectTasks.parentTaskId, task.id))
          .all()
          .filter(
            (child) =>
              !terminalSettings.subtaskStatuses.includes(child.subtaskStatus),
          );
        if (unfinished.length)
          throw new ConflictException(
            'Complete or cancel every subtask before completing this task',
          );
      }
    }
    const priorities = this.getTaskPriorities(resourceId);
    if (input.priority && !priorities.has(input.priority))
      throw new BadRequestException('Invalid priority');
    const updated: ProjectTask = {
      ...task,
      ...(input.title !== undefined
        ? { title: this.validateTaskText(input.title, 'Task title', 200) }
        : {}),
      ...(input.description !== undefined
        ? { description: input.description.trim().slice(0, 10_000) }
        : {}),
      ...(effectiveParent
        ? { priority: effectiveParent.priority }
        : input.priority !== undefined
          ? { priority: input.priority }
          : {}),
      ...(input.parentTaskId !== undefined
        ? { parentTaskId: input.parentTaskId }
        : {}),
      ...(input.subtaskStatus !== undefined
        ? { subtaskStatus: input.subtaskStatus }
        : {}),
      ...(effectiveParent
        ? { workspacePath: effectiveParent.workspacePath }
        : input.workspacePath !== undefined
          ? {
              workspacePath: this.validateTaskWorkspace(
                projectId,
                input.workspacePath,
              ),
            }
          : {}),
      ...(input.executionMode !== undefined
        ? {
            executionMode:
              effectiveParentId && input.executionMode === 'agent'
                ? 'agent'
                : 'manual',
            agentState:
              effectiveParentId && input.executionMode === 'agent'
                ? task.linkedThreadId
                  ? task.agentState
                  : 'ready'
                : 'manual',
          }
        : {}),
      ...(input.agentState !== undefined
        ? { agentState: input.agentState }
        : {}),
      ...(input.estimateMinutes !== undefined
        ? { estimateMinutes: Math.max(0, Math.trunc(input.estimateMinutes)) }
        : {}),
      ...(input.progress !== undefined && !hasChildren
        ? {
            progress: Math.min(100, Math.max(0, Math.trunc(input.progress))),
          }
        : {}),
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
      ...(input.assigneeId !== undefined
        ? { assigneeId: input.assigneeId || null }
        : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.validationCriteria !== undefined
        ? {
            validationCriteria: input.validationCriteria
              .trim()
              .slice(0, 10_000),
          }
        : {}),
      ...(input.labels !== undefined
        ? {
            labels: input.labels
              .map((label) => label.trim())
              .filter(Boolean)
              .slice(0, 20),
          }
        : {}),
      ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
      ...(input.position !== undefined
        ? { position: Math.max(0, Math.trunc(input.position)) }
        : {}),
      ...(input.linkedThreadId !== undefined
        ? { linkedThreadId: input.linkedThreadId }
        : {}),
      ...(input.linkedSimpleChatId !== undefined
        ? { linkedSimpleChatId: input.linkedSimpleChatId }
        : {}),
      ...(effectiveParent
        ? { linkedFilePath: null }
        : input.linkedFilePath !== undefined
          ? { linkedFilePath: input.linkedFilePath?.trim() || null }
          : {}),
      updatedAt: Date.now(),
    };
    if (
      effectiveParentId &&
      this.getTaskBoardTerminalSettings(resourceId).subtaskStatuses.includes(
        updated.subtaskStatus,
      )
    )
      updated.progress = 100;
    this.validateTaskDateRange(updated.startAt, updated.dueAt, effectiveParent);
    if (!effectiveParentId) {
      const children = this.db
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.parentTaskId, task.id))
        .all();
      for (const child of children)
        this.validateTaskDateRange(child.startAt, child.dueAt, updated);
    }
    const validatedAgentThreadId =
      effectiveParentId &&
      task.linkedThreadId &&
      input.agentState === 'validated' &&
      input.subtaskStatus === 'done'
        ? task.linkedThreadId
        : null;
    if (validatedAgentThreadId) {
      requireExecutionAccess();
      const preview = await this.deletion.previewDelete(validatedAgentThreadId);
      if (!preview.canDelete)
        throw new ConflictException(
          'The completed work agent cannot be deleted safely',
        );
      const result = await this.deletion.deleteThread(validatedAgentThreadId, {
        expectedThreadIds: preview.threadIds,
        expectedRunningThreadIds: preview.runningThreadIds,
        expectedPendingApprovalThreadIds: preview.pendingApprovalThreadIds,
        expectedPendingApprovalRequestIds: preview.pendingApprovals.map(
          (approval) => approval.requestId,
        ),
      });
      if (result.status !== 'completed')
        throw new ConflictException(
          'The subtask was not validated because its work agent could not be deleted',
        );
      updated.linkedThreadId = null;
    }
    this.db.transaction((tx) => {
      tx.update(projectTasks)
        .set(updated)
        .where(eq(projectTasks.id, task.id))
        .run();
      const changes = this.taskChanges(task, updated);
      if (Object.keys(changes).length)
        tx.insert(projectTaskActivity)
          .values({
            id: randomUUID(),
            resourceId,
            taskId: task.id,
            taskTitle: updated.title,
            parentTaskId: effectiveParentId,
            action: 'updated',
            changes,
            actorPersonId: actor?.personId ?? null,
            actorName: actor?.name ?? 'Système',
            createdAt: updated.updatedAt,
          })
          .run();
      if (
        !effectiveParentId &&
        (input.workspacePath !== undefined || input.priority !== undefined)
      )
        tx.update(projectTasks)
          .set({
            workspacePath: updated.workspacePath,
            priority: updated.priority,
            linkedFilePath: null,
            updatedAt: Date.now(),
          })
          .where(eq(projectTasks.parentTaskId, task.id))
          .run();
      if (input.dependencyIds !== undefined) {
        tx.delete(projectTaskDependencies)
          .where(eq(projectTaskDependencies.taskId, task.id))
          .run();
        if (!effectiveParentId)
          for (const dependencyId of this.validateDependencyIds(
            resourceId,
            task.id,
            input.dependencyIds,
          ))
            tx.insert(projectTaskDependencies)
              .values({
                taskId: task.id,
                dependsOnTaskId: dependencyId,
                createdAt: Date.now(),
              })
              .run();
      }
    });
    if (task.parentTaskId)
      this.recalculateParentEstimate(
        resourceId,
        task.parentTaskId,
        true,
        actor,
      );
    if (effectiveParentId && effectiveParentId !== task.parentTaskId)
      this.recalculateParentEstimate(
        resourceId,
        effectiveParentId,
        true,
        actor,
      );
    if (!effectiveParentId)
      this.recalculateParentEstimate(resourceId, task.id, false, actor);
    const saved = this.requireTask(resourceId, task.id);
    if (
      input.workspacePath !== undefined ||
      input.parentTaskId !== undefined ||
      !this.folders.get('task', task.id)
    ) {
      this.folders.setFromAbsolutePath(
        projectId,
        'task',
        task.id,
        saved.workspacePath,
      );
      if (!effectiveParentId && input.workspacePath !== undefined)
        for (const child of this.db
          .select()
          .from(projectTasks)
          .where(eq(projectTasks.parentTaskId, task.id))
          .all())
          this.folders.setFromAbsolutePath(
            projectId,
            'task',
            child.id,
            saved.workspacePath,
          );
    }
    return saved;
  }

  async deleteTask(
    projectId: string,
    resourceId: string,
    taskId: string,
    actor?: ProjectActivityActor,
  ) {
    this.getResource(projectId, resourceId);
    const task = this.requireTask(resourceId, taskId);
    const deletedTasks = [
      task,
      ...this.db
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.parentTaskId, task.id))
        .all(),
    ];
    const linkedAgentIds = [
      ...new Set(
        deletedTasks
          .map((deletedTask) => deletedTask.linkedThreadId)
          .filter((threadId): threadId is string => Boolean(threadId)),
      ),
    ];
    for (const threadId of linkedAgentIds) {
      requireExecutionAccess();
      const preview = await this.deletion.previewDelete(threadId);
      if (!preview.canDelete)
        throw new ConflictException(
          'The task cannot be deleted because a linked work agent cannot be deleted safely',
        );
      const result = await this.deletion.deleteThread(threadId, {
        expectedThreadIds: preview.threadIds,
        expectedRunningThreadIds: preview.runningThreadIds,
        expectedPendingApprovalThreadIds: preview.pendingApprovalThreadIds,
        expectedPendingApprovalRequestIds: preview.pendingApprovals.map(
          (approval) => approval.requestId,
        ),
      });
      if (result.status !== 'completed')
        throw new ConflictException(
          'Task deletion stopped while deleting its linked work agent',
        );
    }
    this.db.transaction((tx) => {
      for (const deletedTask of deletedTasks)
        tx.insert(projectTaskActivity)
          .values({
            id: randomUUID(),
            resourceId,
            taskId: deletedTask.id,
            taskTitle: deletedTask.title,
            parentTaskId: deletedTask.parentTaskId,
            action: 'deleted',
            changes: {},
            actorPersonId: actor?.personId ?? null,
            actorName: actor?.name ?? 'Système',
            createdAt: Date.now(),
          })
          .run();
      tx.delete(projectTasks)
        .where(eq(projectTasks.parentTaskId, task.id))
        .run();
      tx.delete(projectTasks).where(eq(projectTasks.id, task.id)).run();
    });
    for (const deletedTask of deletedTasks)
      this.folders.removeContext('task', deletedTask.id);
    if (task.parentTaskId)
      this.recalculateParentEstimate(
        resourceId,
        task.parentTaskId,
        true,
        actor,
      );
    return { ok: true };
  }

  private taskChanges(
    before: ProjectTask,
    after: ProjectTask,
  ): Record<string, { before: unknown; after: unknown }> {
    const ignored = new Set(['updatedAt', 'createdAt', 'resourceId']);
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(after) as Array<keyof ProjectTask>) {
      if (ignored.has(key)) continue;
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        changes[key] = { before: before[key], after: after[key] };
    }
    if (changes.assigneeId)
      changes.assigneeId = {
        before: this.assigneeLabel(before.assigneeId),
        after: this.assigneeLabel(after.assigneeId),
      };
    return changes;
  }

  private recalculateAllParentEstimates(resourceId: string) {
    const tasks = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.resourceId, resourceId))
      .all();
    for (const parent of tasks.filter((task) => !task.parentTaskId))
      if (tasks.some((task) => task.parentTaskId === parent.id))
        this.recalculateParentEstimate(resourceId, parent.id);
  }

  private recalculateParentEstimate(
    resourceId: string,
    parentTaskId: string,
    resetWhenEmpty = true,
    actor?: ProjectActivityActor,
  ) {
    const parent = this.requireTask(resourceId, parentTaskId);
    const children = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.parentTaskId, parentTaskId))
      .all();
    if (!children.length && !resetWhenEmpty) return;
    const estimateMinutes = children.reduce(
      (total, child) => total + child.estimateMinutes,
      0,
    );
    const progress = Math.round(
      children.reduce((total, child) => total + child.progress, 0) /
        Math.max(1, children.length),
    );
    if (
      parent.estimateMinutes === estimateMinutes &&
      parent.progress === progress
    )
      return;
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.update(projectTasks)
        .set({ estimateMinutes, progress, updatedAt: now })
        .where(eq(projectTasks.id, parentTaskId))
        .run();
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      if (parent.estimateMinutes !== estimateMinutes)
        changes.estimateMinutes = {
          before: parent.estimateMinutes,
          after: estimateMinutes,
        };
      if (parent.progress !== progress)
        changes.progress = { before: parent.progress, after: progress };
      if (Object.keys(changes).length)
        tx.insert(projectTaskActivity)
          .values({
            id: randomUUID(),
            resourceId,
            taskId: parent.id,
            taskTitle: parent.title,
            parentTaskId: null,
            action: 'updated',
            changes,
            actorPersonId: actor?.personId ?? null,
            actorName: actor?.name ?? 'Système',
            createdAt: now,
          })
          .run();
    });
  }

  private getTaskBoardTerminalSettings(resourceId: string) {
    const resource = this.db
      .select()
      .from(projectResources)
      .where(eq(projectResources.id, resourceId))
      .get();
    const config =
      resource?.config && typeof resource.config === 'object'
        ? resource.config
        : {};
    const raw =
      config.taskBoardSettings &&
      typeof config.taskBoardSettings === 'object' &&
      !Array.isArray(config.taskBoardSettings)
        ? (config.taskBoardSettings as Record<string, unknown>)
        : {};
    const configuredTaskIds = raw.terminalStatusIds;
    const taskStatusIds = Array.isArray(configuredTaskIds)
      ? configuredTaskIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : this.db
          .select()
          .from(projectTaskStatuses)
          .where(eq(projectTaskStatuses.resourceId, resourceId))
          .all()
          .filter((status) => status.kind === 'done')
          .map((status) => status.id);
    const allowedSubtaskStatuses = new Set([
      'todo',
      'started',
      'review',
      'done',
      'cancelled',
    ]);
    const subtaskStatuses = ['done', 'cancelled'].filter((value) =>
      allowedSubtaskStatuses.has(value),
    );
    return { taskStatusIds, subtaskStatuses };
  }

  private getTaskPriorities(resourceId: string): Set<string> {
    const resource = this.db
      .select()
      .from(projectResources)
      .where(eq(projectResources.id, resourceId))
      .get();
    const config = resource?.config;
    const boardValue = config?.taskBoardSettings;
    const board: Record<string, unknown> | undefined =
      boardValue && typeof boardValue === 'object' && !Array.isArray(boardValue)
        ? (boardValue as Record<string, unknown>)
        : undefined;
    const options: unknown[] = Array.isArray(board?.priorityOptions)
      ? (board.priorityOptions as unknown[])
      : [];
    const configured = options.flatMap((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('id' in value) ||
        typeof value.id !== 'string'
      )
        return [];
      const id = value.id.trim();
      return id ? [id] : [];
    });
    return new Set(
      configured.length ? configured : ['low', 'normal', 'high', 'urgent'],
    );
  }

  async suggestTasks(projectId: string, resourceId: string, prompt: unknown) {
    this.getResource(projectId, resourceId);
    const request = this.validateTaskText(
      prompt,
      'Task planning request',
      4_000,
    );
    return {
      tasks: await this.suggestProjectTasksWithCodex(
        projectId,
        request,
        'plan',
      ),
    };
  }

  private async suggestProjectTasksWithCodex(
    projectId: string,
    prompt: string,
    intent: 'plan' | 'subtasks',
  ) {
    requireExecutionAccess();
    const project = this.get(projectId);
    const text = await this.threads.runProjectStructuredPrompt({
      cwd: project.workspacePath,
      prompt,
      instructions: [
        'Tu es un chef de projet. Construis des propositions concrètes en français.',
        intent === 'plan'
          ? 'Construis d’abord le plan des tâches principales : objectifs, livrables, ordre de priorité, charges et dépendances fin-vers-début entre ces tâches. Ne crée aucune sous-tâche, même si la demande propose un découpage détaillé. Retourne parentTitle vide et executionMode manual pour chaque tâche. Le découpage en sous-tâches se fera dans un second temps, sur demande explicite depuis une tâche.'
          : 'Découpe uniquement la tâche fournie en sous-tâches. Pour chaque proposition, décide si elle peut être exécutée de façon fiable par un agent IA (agent) ou si elle nécessite une intervention humaine (manual), et explique brièvement ce choix dans assignmentReason.',
        'Les titres référencés dans dependsOnTitles doivent correspondre exactement à un autre titre de la liste. Dans labels, utilise exclusivement les labels disponibles explicitement fournis dans la demande ; sinon retourne une liste vide.',
      ].join(' '),
      outputSchema: (intent === 'plan'
        ? PROJECT_PLAN_SCHEMA
        : PROJECT_TASKS_SCHEMA) as never,
    });
    const parsed = JSON.parse(text) as {
      tasks?: Array<{
        title?: string;
        description?: string;
        priority?: string;
        estimateHours?: number;
        validationCriteria?: string;
        parentTitle?: string;
        dependsOnTitles?: string[];
        executionMode?: string;
        assignmentReason?: string;
        labels?: string[];
      }>;
    };
    if (
      intent === 'plan' &&
      parsed.tasks?.some((task) => task.parentTitle?.trim())
    )
      throw new BadRequestException(
        'Le plan doit contenir uniquement des tâches principales. Relancez la génération ; le découpage en sous-tâches se fait ensuite depuis une tâche.',
      );
    return (parsed.tasks ?? []).map((task) => ({
      title: task.title?.trim() || 'Nouvelle tâche',
      description: task.description?.trim() || '',
      priority: ['low', 'normal', 'high', 'urgent'].includes(
        task.priority ?? '',
      )
        ? task.priority!
        : 'normal',
      estimateHours: Math.max(0, Number(task.estimateHours) || 0),
      validationCriteria: task.validationCriteria?.trim() || '',
      parentTitle: task.parentTitle?.trim() || '',
      dependsOnTitles: (task.dependsOnTitles ?? [])
        .map((title) => title.trim())
        .filter(Boolean),
      executionMode:
        intent === 'subtasks' && task.executionMode === 'agent'
          ? 'agent'
          : 'manual',
      assignmentReason: task.assignmentReason?.trim() || '',
      labels: (task.labels ?? []).map((label) => label.trim()).filter(Boolean),
    }));
  }

  async replanTasks(projectId: string, resourceId: string, prompt: unknown) {
    this.getResource(projectId, resourceId);
    const request = (typeof prompt === 'string' ? prompt : '')
      .trim()
      .slice(0, 4_000);
    const tasks = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.resourceId, resourceId))
      .all()
      .filter((task) => !task.parentTaskId);
    if (!tasks.length) return { tasks: [] };
    const ids = new Set(tasks.map((task) => task.id));
    const dependencies = this.db.select().from(projectTaskDependencies).all();
    const iso = (value: number | null) =>
      value ? new Date(value).toISOString().slice(0, 10) : '';
    const context = tasks.map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      estimateHours: task.estimateMinutes / 60,
      startDate: iso(task.startAt),
      dueDate: iso(task.dueAt),
      progress: task.progress,
      dependencyIds: dependencies
        .filter((dependency) => dependency.taskId === task.id)
        .map((dependency) => dependency.dependsOnTaskId)
        .filter((id) => ids.has(id)),
    }));
    const project = this.get(projectId);
    const text = await this.threads.runProjectStructuredPrompt({
      cwd: project.workspacePath,
      prompt: `Objectif ou contraintes complémentaires : ${request || 'Optimiser le planning existant sans contrainte supplémentaire.'}\n\nTâches existantes :\n${JSON.stringify(context, null, 2)}`,
      instructions:
        'Tu es un chef de projet prudent. Replanifie uniquement les tâches principales fournies. Conserve exactement leurs identifiants. Propose des dates au format YYYY-MM-DD, une charge réaliste et des dépendances fin-vers-début cohérentes. Ne crée ni ne supprime aucune tâche. Retourne toutes les tâches, y compris celles que tu proposes de laisser inchangées, et justifie brièvement chaque choix.',
      outputSchema: PROJECT_REPLAN_SCHEMA as never,
    });
    const suggestions = ((JSON.parse(text) as { tasks?: unknown[] }).tasks ??
      []) as Array<{
      taskId: string;
      priority: string;
      estimateHours: number;
      startDate: string;
      dueDate: string;
      dependencyIds: string[];
      reason: string;
    }>;
    const date = (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const parsed = new Date(`${value}T12:00:00`).getTime();
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      tasks: suggestions
        .filter((suggestion) => ids.has(suggestion.taskId))
        .map((suggestion) => {
          const task = tasks.find((item) => item.id === suggestion.taskId)!;
          const hasSubtasks =
            this.db
              .select()
              .from(projectTasks)
              .where(eq(projectTasks.parentTaskId, task.id))
              .all().length > 0;
          return {
            ...suggestion,
            estimateHours: hasSubtasks
              ? task.estimateMinutes / 60
              : suggestion.estimateHours,
            startAt: date(suggestion.startDate),
            dueAt: date(suggestion.dueDate),
            dependencyIds: suggestion.dependencyIds.filter(
              (id) => ids.has(id) && id !== suggestion.taskId,
            ),
          };
        }),
    };
  }

  async taskAdvice(
    projectId: string,
    resourceId: string,
    rawMode: unknown,
    rawAvailableHours: unknown,
  ) {
    this.getResource(projectId, resourceId);
    const mode = rawMode === 'work' ? 'work' : 'analysis';
    const availableHours = Number(rawAvailableHours);
    if (
      mode === 'work' &&
      (!Number.isFinite(availableHours) ||
        availableHours <= 0 ||
        availableHours > 168)
    )
      throw new BadRequestException(
        'Available hours must be between 0 and 168',
      );
    const tasks = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.resourceId, resourceId))
      .all();
    const statuses = this.db
      .select()
      .from(projectTaskStatuses)
      .where(eq(projectTaskStatuses.resourceId, resourceId))
      .all();
    const dependencies = this.db.select().from(projectTaskDependencies).all();
    const terminal = new Set(
      this.getTaskBoardTerminalSettings(resourceId).taskStatusIds,
    );
    const iso = (value: number | null) =>
      value ? new Date(value).toISOString().slice(0, 10) : '';
    const context = tasks.map((task) => ({
      id: task.id,
      parentTaskId: task.parentTaskId,
      title: task.title,
      description: task.description,
      status: task.parentTaskId
        ? task.subtaskStatus
        : (statuses.find((status) => status.id === task.statusId)?.name ?? ''),
      terminal: task.parentTaskId
        ? ['done', 'cancelled'].includes(task.subtaskStatus)
        : terminal.has(task.statusId),
      priority: task.priority,
      estimateHours: task.estimateMinutes / 60,
      progress: task.progress,
      startDate: iso(task.startAt),
      dueDate: iso(task.dueAt),
      labels: task.labels,
      executionMode: task.executionMode,
      validationCriteria: task.validationCriteria,
      dependencyIds: dependencies
        .filter((dependency) => dependency.taskId === task.id)
        .map((dependency) => dependency.dependsOnTaskId),
    }));
    const input = {
      mode,
      availableHours: mode === 'work' ? availableHours : null,
      today: new Date().toISOString().slice(0, 10),
      tasks: context,
    };
    const project = this.get(projectId);
    const text = await this.threads.runProjectStructuredPrompt({
      cwd: project.workspacePath,
      prompt: JSON.stringify(input),
      instructions:
        mode === 'analysis'
          ? 'Tu es un conseiller de gestion de projet prudent. Analyse exclusivement les données fournies. Signale les retards, échéances proches, blocages, incohérences, surcharges et améliorations concrètes. Ne prétends jamais modifier le planning. Classe les conseils par importance et cite les identifiants exacts des tâches concernées.'
          : `Tu es un conseiller de travail. Propose un programme réaliste qui tient dans ${availableHours} heures. Privilégie les urgences, échéances, dépendances débloquées et travaux déjà commencés. Ne recommande aucune tâche terminée ou bloquée par une dépendance non terminée. Les durées proposées doivent totaliser au maximum le temps disponible.`,
      outputSchema: TASK_ADVICE_SCHEMA as never,
    });
    const parsed = JSON.parse(text) as {
      summary?: string;
      health?: 'good' | 'watch' | 'at_risk';
      advice?: Array<{
        severity: 'alert' | 'recommendation' | 'opportunity' | 'info';
        title: string;
        description: string;
        taskIds: string[];
      }>;
      work?: Array<{
        taskId: string;
        recommendedMinutes: number;
        reason: string;
      }>;
    };
    const ids = new Set(tasks.map((task) => task.id));
    return {
      summary: String(parsed.summary ?? '').trim(),
      health: ['good', 'watch', 'at_risk'].includes(parsed.health ?? '')
        ? parsed.health!
        : 'watch',
      advice: (parsed.advice ?? []).map((item) => ({
        ...item,
        taskIds: item.taskIds.filter((id) => ids.has(id)),
      })),
      work: (parsed.work ?? []).filter((item) => ids.has(item.taskId)),
    };
  }

  async suggestSubtasks(
    projectId: string,
    resourceId: string,
    taskId: string,
    input: {
      title?: unknown;
      description?: unknown;
      validationCriteria?: unknown;
    },
  ) {
    const resource = this.getResource(projectId, resourceId);
    const task = this.requireTask(resourceId, taskId);
    if (task.parentTaskId)
      throw new BadRequestException(
        'A subtask cannot be divided into subtasks',
      );
    const title = this.validateTaskText(
      input.title ?? task.title,
      'Task title',
      200,
    );
    const description = (
      typeof input.description === 'string'
        ? input.description
        : task.description
    )
      .trim()
      .slice(0, 10_000);
    const validationCriteria = (
      typeof input.validationCriteria === 'string'
        ? input.validationCriteria
        : task.validationCriteria
    )
      .trim()
      .slice(0, 10_000);
    const taskBoardSettings =
      resource.config &&
      typeof resource.config === 'object' &&
      !Array.isArray(resource.config) &&
      resource.config.taskBoardSettings &&
      typeof resource.config.taskBoardSettings === 'object' &&
      !Array.isArray(resource.config.taskBoardSettings)
        ? (resource.config.taskBoardSettings as Record<string, unknown>)
        : {};
    const configuredLabels = Array.isArray(taskBoardSettings.labels)
      ? taskBoardSettings.labels
          .map((label) =>
            label &&
            typeof label === 'object' &&
            !Array.isArray(label) &&
            typeof (label as Record<string, unknown>).name === 'string'
              ? String((label as Record<string, unknown>).name).trim()
              : '',
          )
          .filter(Boolean)
          .slice(0, 100)
      : [];
    const allowedLabels = new Map(
      configuredLabels.map((label) => [label.toLocaleLowerCase(), label]),
    );
    const labelsInstruction = configuredLabels.length
      ? `\nLabels disponibles : ${configuredLabels.join(', ')}. Pour chaque sous-tâche, propose zéro, un ou plusieurs labels pertinents exclusivement parmi cette liste. N'invente aucun label.`
      : `\nAucun label n'est configuré : retourne une liste labels vide pour chaque sous-tâche.`;
    const prompt = `Découpe la tâche suivante en sous-tâches concrètes, suffisamment petites pour être exécutées et validées séparément. Ne retourne pas la tâche principale elle-même. Ne crée aucune dépendance entre les sous-tâches. Propose entre 2 et 10 sous-tâches. Pour chacune, détermine si un agent IA peut raisonnablement la réaliser seul ou si elle doit rester manuelle.${labelsInstruction}\n\nTâche : ${title}\nDescription : ${description || 'Non précisée'}\nConditions de validation : ${validationCriteria || 'Non précisées'}`;
    const suggestions = await this.suggestProjectTasksWithCodex(
      projectId,
      prompt,
      'subtasks',
    );
    return {
      tasks: suggestions.slice(0, 10).map((suggestion) => ({
        ...suggestion,
        labels: [
          ...new Set(
            suggestion.labels
              .map((label) => allowedLabels.get(label.toLocaleLowerCase()))
              .filter((label): label is string => Boolean(label)),
          ),
        ],
        parentTitle: title,
        dependsOnTitles: [],
      })),
    };
  }

  private requireTaskStatus(resourceId: string, statusId: string) {
    const status = this.db
      .select()
      .from(projectTaskStatuses)
      .where(eq(projectTaskStatuses.id, statusId))
      .get();
    if (!status || status.resourceId !== resourceId)
      throw new NotFoundException('Task status not found');
    return status;
  }

  private requireTask(resourceId: string, taskId: string) {
    const task = this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.id, taskId))
      .get();
    if (!task || task.resourceId !== resourceId)
      throw new NotFoundException('Task not found');
    return task;
  }

  private validateTaskWorkspace(
    projectId: string,
    value: string | null | undefined,
  ) {
    if (!value) return null;
    const normalized = path.resolve(value);
    const allowed = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .all();
    if (
      !allowed.some(
        (workspace) =>
          normalized === workspace.path ||
          normalized.startsWith(`${workspace.path}${path.sep}`),
      )
    )
      throw new BadRequestException(
        'Task folder must be inside a project workspace',
      );
    return normalized;
  }

  private validateTaskDateRange(
    startAt: number | null,
    dueAt: number | null,
    parent: Pick<ProjectTask, 'startAt' | 'dueAt'> | null,
  ) {
    if (startAt !== null && dueAt !== null && startAt > dueAt)
      throw new BadRequestException(
        'The start date cannot be after the end date',
      );
    if (!parent) return;
    if (
      (parent.startAt !== null &&
        startAt !== null &&
        startAt < parent.startAt) ||
      (parent.dueAt !== null && dueAt !== null && dueAt > parent.dueAt)
    )
      throw new BadRequestException(
        'A subtask must stay within its parent task date range',
      );
  }

  private validateDependencyIds(
    resourceId: string,
    taskId: string,
    values: string[] | undefined,
  ) {
    const ids = [...new Set(values ?? [])].filter((id) => id !== taskId);
    for (const id of ids) {
      const dependency = this.requireTask(resourceId, id);
      if (dependency.parentTaskId)
        throw new BadRequestException('Subtasks cannot be dependencies');
      if (this.dependencyReaches(id, taskId, new Set()))
        throw new BadRequestException(
          'Task dependencies cannot contain a cycle',
        );
    }
    return ids;
  }

  private dependencyReaches(
    currentId: string,
    targetId: string,
    visited: Set<string>,
  ): boolean {
    if (currentId === targetId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    return this.db
      .select()
      .from(projectTaskDependencies)
      .where(eq(projectTaskDependencies.taskId, currentId))
      .all()
      .some((dependency) =>
        this.dependencyReaches(dependency.dependsOnTaskId, targetId, visited),
      );
  }

  private async syncAgentStates(resourceId: string) {
    const snapshot = await this.metadata.read().catch(() => null);
    if (!snapshot) return;
    const states = new Map(
      snapshot.entries.map((entry) => [entry.thread.id, entry.thread.status]),
    );
    const review = this.db
      .select()
      .from(projectTaskStatuses)
      .where(eq(projectTaskStatuses.resourceId, resourceId))
      .all()
      .find((status) => status.kind === 'review');
    for (const task of this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.resourceId, resourceId))
      .all()) {
      if (
        !task.linkedThreadId ||
        !['running', 'waiting'].includes(task.agentState)
      )
        continue;
      const state = states.get(task.linkedThreadId);
      if (!state) continue;
      if (state.type === 'active') {
        const waiting = state.activeFlags.some((flag) =>
          ['waitingOnApproval', 'waitingOnUserInput'].includes(flag),
        );
        const next = waiting ? 'waiting' : 'running';
        if (task.agentState !== next)
          this.db
            .update(projectTasks)
            .set({ agentState: next, updatedAt: Date.now() })
            .where(eq(projectTasks.id, task.id))
            .run();
        continue;
      }
      this.db
        .update(projectTasks)
        .set({
          agentState: 'review',
          ...(task.parentTaskId
            ? { subtaskStatus: 'review' }
            : review
              ? { statusId: review.id }
              : {}),
          updatedAt: Date.now(),
        })
        .where(eq(projectTasks.id, task.id))
        .run();
    }
  }

  private automationConfig(resource: ProjectResource): {
    automations: ProjectAutomation[];
    runs: AutomationRun[];
  } {
    const config = resource.config;
    return {
      automations: Array.isArray(config.automations)
        ? (config.automations as ProjectAutomation[])
        : [],
      runs: Array.isArray(config.runs) ? (config.runs as AutomationRun[]) : [],
    };
  }

  private saveAutomationConfig(
    resource: ProjectResource,
    automations: ProjectAutomation[],
    runs: AutomationRun[],
  ) {
    const updatedAt = Date.now();
    const config = {
      ...resource.config,
      automations,
      runs: runs.slice(0, 100),
    };
    this.db
      .update(projectResources)
      .set({ config, updatedAt })
      .where(eq(projectResources.id, resource.id))
      .run();
    return config;
  }

  private nextAutomationRun(item: ProjectAutomation, from = new Date()) {
    if (!item.active || item.schedule === 'manual') return null;
    const [hour, minute] = item.time.split(':').map(Number);
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(
      Number.isFinite(hour) ? hour : 8,
      Number.isFinite(minute) ? minute : 0,
      0,
      0,
    );
    if (item.schedule === 'daily') {
      if (next <= from) next.setDate(next.getDate() + 1);
    } else if (item.schedule === 'weekly') {
      const delta = (item.weekday - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + delta);
      if (next <= from) next.setDate(next.getDate() + 7);
    } else {
      next.setDate(Math.max(1, Math.min(28, item.monthday)));
      if (next <= from) next.setMonth(next.getMonth() + 1);
    }
    return next.getTime();
  }

  upsertAutomation(
    projectId: string,
    resourceId: string,
    input: Partial<ProjectAutomation>,
    automationId?: string,
  ) {
    const resource = this.getResource(projectId, resourceId);
    if (resource.type !== 'automation_board')
      throw new BadRequestException('Not an automation resource');
    const { automations, runs } = this.automationConfig(resource);
    const existing = automationId
      ? automations.find((item) => item.id === automationId)
      : undefined;
    if (automationId && !existing)
      throw new NotFoundException('Automation not found');
    const now = Date.now();
    const schedule: AutomationSchedule = [
      'daily',
      'weekly',
      'monthly',
    ].includes(String(input.schedule))
      ? (input.schedule as AutomationSchedule)
      : 'manual';
    const item: ProjectAutomation = {
      id: existing?.id ?? randomUUID(),
      name: this.validateTaskText(
        input.name ?? existing?.name,
        'Automation name',
        120,
      ),
      instructions: this.validateTaskText(
        input.instructions ?? existing?.instructions,
        'Automation instructions',
        6_000,
      ),
      schedule,
      time: /^\d{2}:\d{2}$/.test(String(input.time))
        ? String(input.time)
        : (existing?.time ?? '08:00'),
      weekday: Math.max(
        0,
        Math.min(6, Number(input.weekday ?? existing?.weekday ?? 1)),
      ),
      monthday: Math.max(
        1,
        Math.min(28, Number(input.monthday ?? existing?.monthday ?? 1)),
      ),
      targetType: ['workspace', 'workspace_transfer'].includes(
        String(input.targetType),
      )
        ? (input.targetType as 'workspace' | 'workspace_transfer')
        : 'task_board',
      targetId: String(input.targetId ?? existing?.targetId ?? '').trim(),
      mode: ['proposal', 'action'].includes(String(input.mode))
        ? (input.mode as 'proposal' | 'action')
        : 'analysis',
      approvalRequired:
        input.mode === 'analysis' ? false : input.approvalRequired !== false,
      active: input.active ?? existing?.active ?? true,
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    item.nextRunAt = this.nextAutomationRun(item);
    const next = existing
      ? automations.map((value) => (value.id === item.id ? item : value))
      : [...automations, item];
    this.saveAutomationConfig(resource, next, runs);
    return item;
  }

  deleteAutomation(
    projectId: string,
    resourceId: string,
    automationId: string,
  ) {
    const resource = this.getResource(projectId, resourceId);
    const { automations, runs } = this.automationConfig(resource);
    this.saveAutomationConfig(
      resource,
      automations.filter((item) => item.id !== automationId),
      runs.filter((run) => run.automationId !== automationId),
    );
    return { ok: true };
  }

  async runAutomation(
    projectId: string,
    resourceId: string,
    automationId: string,
  ) {
    let resource = this.getResource(projectId, resourceId);
    const config = this.automationConfig(resource);
    const item = config.automations.find((value) => value.id === automationId);
    if (!item) throw new NotFoundException('Automation not found');
    if (this.runningAutomationIds.has(automationId))
      throw new ConflictException('Automation already running');
    this.runningAutomationIds.add(automationId);
    const run: AutomationRun = {
      id: randomUUID(),
      automationId,
      status: 'running',
      result: '',
      error: '',
      startedAt: Date.now(),
      finishedAt: null,
      transferRunId: null,
    };
    this.saveAutomationConfig(resource, config.automations, [
      run,
      ...config.runs,
    ]);
    try {
      let context = '';
      if (item.targetType === 'task_board') {
        const board = await this.readTaskBoard(projectId, item.targetId);
        context = JSON.stringify({
          statuses: board.statuses,
          tasks: board.tasks,
          dependencies: board.dependencies,
        });
      } else if (item.targetType === 'workspace') {
        const workspace = this.requireWorkspace(projectId, item.targetId);
        context = `Workspace autorisé : ${workspace.path}. Aucun contenu de fichier n'est transmis automatiquement.`;
      } else {
        if (!this.workspaceTransfers)
          throw new ConflictException('Workspace transfers are unavailable');
        const preview = await this.workspaceTransfers.preview(
          projectId,
          item.targetId,
        );
        run.transferRunId = preview.id;
        context = `Aperçu du transfert : ${JSON.stringify(preview.summary)}.`;
        if (item.mode === 'action' && !item.approvalRequired) {
          const applied = await this.workspaceTransfers.execute(
            projectId,
            item.targetId,
            preview.id,
          );
          run.result = `Transfert exécuté : ${JSON.stringify(applied.run.summary)}.`;
          run.status = 'success';
        }
      }
      if (!run.result) {
        run.result = await this.simpleChat.runProjectAutomation(
          `Automatisation du projet « ${this.get(projectId).name} ».\nMode : ${item.mode}.\nInstruction : ${item.instructions}\nContexte : ${context}\nProduis un rapport clair en français. Ne prétends pas avoir appliqué de modification.`,
        );
        run.status = item.mode === 'analysis' ? 'success' : 'pending_approval';
      }
    } catch (error) {
      run.status = 'error';
      run.error = error instanceof Error ? error.message : 'Automation failed';
    } finally {
      this.runningAutomationIds.delete(automationId);
    }
    run.finishedAt = Date.now();
    item.lastRunAt = run.finishedAt;
    item.nextRunAt = this.nextAutomationRun(item, new Date(run.finishedAt));
    item.updatedAt = run.finishedAt;
    resource = this.getResource(projectId, resourceId);
    const latest = this.automationConfig(resource);
    this.saveAutomationConfig(
      resource,
      latest.automations.map((value) => (value.id === item.id ? item : value)),
      [run, ...latest.runs.filter((value) => value.id !== run.id)],
    );
    return { run };
  }

  async reviewAutomationRun(
    projectId: string,
    resourceId: string,
    runId: string,
    decision: 'approved' | 'rejected',
  ) {
    const resource = this.getResource(projectId, resourceId);
    if (resource.type !== 'automation_board')
      throw new BadRequestException('Not an automation resource');
    const { automations, runs } = this.automationConfig(resource);
    const run = runs.find((value) => value.id === runId);
    if (!run) throw new NotFoundException('Automation run not found');
    if (run.status !== 'pending_approval')
      throw new ConflictException('Automation run is not awaiting approval');
    const automation = automations.find((item) => item.id === run.automationId);
    if (
      decision === 'approved' &&
      run.transferRunId &&
      automation?.targetType === 'workspace_transfer' &&
      automation.mode === 'action'
    ) {
      if (!this.workspaceTransfers)
        throw new ConflictException('Workspace transfers are unavailable');
      const applied = await this.workspaceTransfers.execute(
        projectId,
        automation.targetId,
        run.transferRunId,
      );
      run.result = `${run.result}\nTransfert exécuté : ${JSON.stringify(applied.run.summary)}.`;
    }
    run.status = decision;
    this.saveAutomationConfig(resource, automations, runs);
    return { run };
  }

  private async runDueAutomations() {
    const now = Date.now();
    for (const resource of this.db.select().from(projectResources).all()) {
      if (resource.type !== 'automation_board') continue;
      const { automations } = this.automationConfig(resource);
      for (const item of automations)
        if (item.active && item.nextRunAt && item.nextRunAt <= now)
          await this.runAutomation(
            resource.projectId,
            resource.id,
            item.id,
          ).catch(() => undefined);
    }
  }

  private validateTaskText(value: unknown, label: string, max: number) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > max)
      throw new BadRequestException(
        `${label} must contain 1 to ${max} characters`,
      );
    return text;
  }

  private validateColor(value: unknown) {
    const colors = new Set([
      'slate',
      'blue',
      'amber',
      'red',
      'green',
      'purple',
      'teal',
      'pink',
    ]);
    return typeof value === 'string' && colors.has(value) ? value : 'slate';
  }

  getResource(projectId: string, resourceId: string): ProjectResource {
    this.get(projectId);
    const resource = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.id, resourceId),
          eq(projectResources.projectId, projectId),
        ),
      )
      .get();
    if (!resource) throw new NotFoundException('Project resource not found');
    return resource;
  }

  updateResource(
    projectId: string,
    resourceId: string,
    input: {
      name?: string;
      config?: Record<string, unknown>;
      labelRenames?: Array<{ from: string; to: string }>;
      removedLabels?: string[];
    },
  ): ProjectResource {
    const resource = this.getResource(projectId, resourceId);
    if ('projectId' in input)
      throw new ConflictException('Resources cannot be moved between projects');
    const name = input.name === undefined ? resource.name : input.name.trim();
    if (!name) throw new BadRequestException('Resource name is required');
    if (name.length > 120)
      throw new BadRequestException('Resource name is too long');
    const config =
      input.config === undefined
        ? resource.config
        : this.validateResourceConfig(input.config);
    const updatedAt = Date.now();
    const labelRenames = new Map(
      (input.labelRenames ?? [])
        .slice(0, 50)
        .map((change) => [
          this.validateOptionalLabel(change.from),
          this.validateOptionalLabel(change.to),
        ]),
    );
    const removedLabels = new Set(
      (input.removedLabels ?? [])
        .slice(0, 50)
        .map((label) => this.validateOptionalLabel(label)),
    );
    this.db
      .update(projectResources)
      .set({ name, config, updatedAt })
      .where(eq(projectResources.id, resourceId))
      .run();
    if (labelRenames.size || removedLabels.size) {
      for (const task of this.db
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.resourceId, resourceId))
        .all()) {
        const labels = [
          ...new Set(
            task.labels
              .map((label) => labelRenames.get(label) ?? label)
              .filter((label) => !removedLabels.has(label)),
          ),
        ];
        if (JSON.stringify(labels) !== JSON.stringify(task.labels))
          this.db
            .update(projectTasks)
            .set({ labels, updatedAt })
            .where(eq(projectTasks.id, task.id))
            .run();
      }
    }
    if (input.config !== undefined)
      this.recalculateAllParentEstimates(resourceId);
    return {
      ...resource,
      name,
      config,
      updatedAt,
    };
  }

  updateSidebarOrder(projectId: string, value: unknown) {
    const project = this.get(projectId);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
      throw new BadRequestException('Sidebar order must be a string array');
    const order = value as string[];
    if (order.length > 2_000 || new Set(order).size !== order.length)
      throw new BadRequestException('Sidebar order is invalid');

    const valid = new Set<string>();
    for (const resource of this.db
      .select()
      .from(projectResources)
      .where(eq(projectResources.projectId, projectId))
      .all())
      valid.add(`resource:${resource.id}`);
    for (const agent of this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.projectId, projectId))
      .all())
      valid.add(`agent:${agent.threadId}`);
    for (const thread of this.db
      .select()
      .from(simpleChatThreads)
      .where(eq(simpleChatThreads.projectId, projectId))
      .all())
      valid.add(`simple:${thread.id}`);
    if (order.some((key) => !valid.has(key)))
      throw new BadRequestException(
        'Sidebar order contains an item from another project',
      );

    const sidebarOrder = [
      ...order,
      ...[...valid].filter((key) => !order.includes(key)),
    ];
    const updatedAt = Date.now();
    this.db
      .update(projects)
      .set({ sidebarOrder, updatedAt })
      .where(eq(projects.id, projectId))
      .run();
    return { ...project, sidebarOrder, updatedAt };
  }

  private validateResourceConfig(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException('Resource config must be an object');
    if (JSON.stringify(value).length > 20_000)
      throw new BadRequestException('Resource config is too large');
    return value as Record<string, unknown>;
  }

  private validateOptionalLabel(value: unknown): string {
    const label = typeof value === 'string' ? value.trim() : '';
    if (!label || label.length > 50)
      throw new BadRequestException('Label must contain 1 to 50 characters');
    return label;
  }

  deleteResource(projectId: string, resourceId: string) {
    const resource = this.getResource(projectId, resourceId);
    this.db.transaction((tx) => {
      // Tasks reference statuses with RESTRICT. Delete tasks first instead of
      // relying on SQLite to choose a safe order for the resource cascade.
      tx.delete(projectTasks)
        .where(eq(projectTasks.resourceId, resource.id))
        .run();
      tx.delete(projectTaskStatuses)
        .where(eq(projectTaskStatuses.resourceId, resource.id))
        .run();
      tx.delete(projectResources)
        .where(eq(projectResources.id, resource.id))
        .run();
    });
    return { ok: true };
  }

  rename(id: string, nameValue: string): Project {
    const project = this.get(id);
    const name = this.validateName(nameValue);
    const updatedAt = Date.now();
    this.db
      .update(projects)
      .set({ name, updatedAt })
      .where(eq(projects.id, id))
      .run();
    return { ...project, name, updatedAt };
  }

  async remove(
    id: string,
    confirmation: string,
    deleteWorkspaceIds: string[] = [],
  ) {
    const project = this.get(id);
    if (confirmation !== project.name)
      throw new BadRequestException('Project confirmation does not match');
    const attached = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, id))
      .all();
    const selectedWorkspaceIds = new Set(deleteWorkspaceIds);
    const workspacesToDelete = attached.filter((workspace) =>
      selectedWorkspaceIds.has(workspace.id),
    );
    const agents = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.projectId, id))
      .all();
    const handled = new Set<string>();
    for (const agent of agents) {
      if (handled.has(agent.threadId)) continue;
      const preview = await this.deletion.previewDelete(agent.threadId);
      if (!preview.canDelete)
        throw new ConflictException(
          'One or more work agents cannot be deleted safely',
        );
      const result = await this.deletion.deleteThread(agent.threadId, {
        expectedThreadIds: preview.threadIds,
        expectedRunningThreadIds: preview.runningThreadIds,
        expectedPendingApprovalThreadIds: preview.pendingApprovalThreadIds,
        expectedPendingApprovalRequestIds: preview.pendingApprovals.map(
          (approval) => approval.requestId,
        ),
      });
      if (result.status !== 'completed')
        throw new ConflictException(
          'Project deletion stopped while deleting work agents',
        );
      preview.threadIds.forEach((threadId) => handled.add(threadId));
    }
    const resources = this.db
      .select()
      .from(projectResources)
      .where(eq(projectResources.projectId, id))
      .all();
    this.db.transaction((tx) => {
      // A task status is RESTRICTed while tasks still reference it. The
      // explicit child-first order makes whole-project deletion deterministic.
      for (const resource of resources) {
        tx.delete(projectTasks)
          .where(eq(projectTasks.resourceId, resource.id))
          .run();
        tx.delete(projectTaskStatuses)
          .where(eq(projectTaskStatuses.resourceId, resource.id))
          .run();
      }
      tx.delete(projectResources)
        .where(eq(projectResources.projectId, id))
        .run();
      // Databases created before project-aware simple chats were introduced
      // can still have a NO ACTION foreign key here. Delete these threads
      // explicitly so those installations do not block project deletion.
      tx.delete(simpleChatThreads)
        .where(eq(simpleChatThreads.projectId, id))
        .run();
      tx.delete(projects).where(eq(projects.id, id)).run();
    });
    for (const workspace of workspacesToDelete) {
      if (workspace.primary)
        await this.files.deleteManagedWorkspace(workspace.path);
      else await this.files.deletePath(workspace.path, true);
    }
    return {
      ok: true,
      deletedWorkspaces: workspacesToDelete.map((workspace) => workspace.path),
      preservedWorkspaces: attached
        .filter((workspace) => !selectedWorkspaceIds.has(workspace.id))
        .map((workspace) => workspace.path),
    };
  }

  private requireWorkspace(
    projectId: string,
    workspacePath: string,
  ): ProjectWorkspace {
    const workspace = this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.path, workspacePath))
      .get();
    if (!workspace || workspace.projectId !== projectId)
      throw new BadRequestException(
        'Workspace is not attached to this project',
      );
    return workspace;
  }

  get(id: string): Project {
    requireProjectAccess(id);
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  getWorkspace(projectId: string, workspaceId: string) {
    const workspace = this.db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, workspaceId),
          eq(projectWorkspaces.projectId, projectId),
        ),
      )
      .get();
    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }

  private validateName(value: string): string {
    const name = value?.trim();
    if (!name) throw new BadRequestException('Project name is required');
    this.files.validateEntryName(name);
    return name;
  }

  private layoutMigration?: Promise<void>;

  private ensurePrimaryWorkspaces(): Promise<void> {
    return (this.layoutMigration ??= new ProjectWorkspaceLayout(this.db)
      .migrate()
      .catch((error) => {
        this.layoutMigration = undefined;
        throw error;
      }));
  }
}
