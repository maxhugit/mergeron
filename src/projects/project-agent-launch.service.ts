import { taskWorkReference } from './task-work-reference';
/** Creation is reserved before native work; recovery never replays an uncertain turn. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql, inArray } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectAgentLaunches as launches,
  projectAgentThreads,
  projectDeliverables,
  projectTasks,
  type AgentLaunchContext,
} from '../database/schema';
import {
  currentAccess,
  requireExecutionAccess,
  requireThreadAccess,
  canReadThread,
} from '../auth/access-context';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';
import { ThreadsService } from '../threads/threads.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { ProjectsService } from './projects.service';

type Receipt = typeof launches.$inferSelect;
export type DeliverableAgentInput = {
  version: number;
  requestId?: unknown;
  subtaskId?: string;
  subtaskTitle?: string;
  existingThreadId?: string;
};
@Injectable()
export class ProjectAgentLaunchService {
  private readonly inFlight = new Set<string>();
  constructor(
    @Inject(DRIZZLE_DB) private db: AppDatabase,
    private projects: ProjectsService,
    private threads: ThreadsService,
    private deliverables: DeliverablesService,
    private metadata: ThreadMetadataService,
    @Optional() private mutations?: GitMutationGateService,
  ) {}

  private owner() {
    requireExecutionAccess();
    const access = currentAccess();
    if (!access)
      throw new ForbiddenException('An authenticated identity is required');
    access.identities.requireActive(access.identity);
    return (
      access.identity.personId ??
      access.identity.subject ??
      access.identity.kind
    );
  }
  private task(projectId: string, resourceId: string, taskId: string) {
    this.projects.getResource(projectId, resourceId);
    const task = this.db
      .select()
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.id, taskId),
          eq(projectTasks.resourceId, resourceId),
        ),
      )
      .get();
    if (!task?.parentTaskId || task.executionMode !== 'agent')
      throw new BadRequestException('Select an agent execution subtask');
    return { ...task, workspacePath: taskWorkReference(this.db, task).path };
  }
  private view(receipt: Receipt) {
    if (receipt.threadId) requireThreadAccess(receipt.threadId);
    return {
      id: receipt.id,
      state: receipt.state,
      phase: receipt.phase,
      threadId: receipt.threadId,
      taskId: receipt.context.taskId,
      createdSubtask: receipt.context.createdSubtask,
      resourceId: receipt.resourceId,
      kind: receipt.context.kind,
      targetId: receipt.context.targetId,
      revision: receipt.updatedAt,
      busy: this.inFlight.has(receipt.id),
    };
  }
  private get(projectId: string, resourceId: string, id: string) {
    const ownerId = this.owner();
    this.projects.getResource(projectId, resourceId);
    const receipt = this.db
      .select()
      .from(launches)
      .where(
        and(
          eq(launches.id, id),
          eq(launches.projectId, projectId),
          eq(launches.resourceId, resourceId),
          eq(launches.ownerId, ownerId),
        ),
      )
      .get();
    if (!receipt)
      throw new ForbiddenException('Launch is not available to this user');
    if (receipt.context.kind === 'task')
      this.task(projectId, resourceId, receipt.context.targetId);
    else this.deliverables.get(projectId, resourceId, receipt.context.targetId);
    return receipt;
  }
  private save(
    receipt: Receipt,
    changes: Partial<
      Pick<
        Receipt,
        'state' | 'phase' | 'threadId' | 'context' | 'scope' | 'taskId'
      >
    >,
  ) {
    const row = this.db
      .update(launches)
      .set({
        ...changes,
        updatedAt: Math.max(Date.now(), receipt.updatedAt + 1),
      })
      .where(
        and(
          eq(launches.id, receipt.id),
          eq(launches.updatedAt, receipt.updatedAt),
        ),
      )
      .returning()
      .get();
    if (!row)
      throw new ConflictException('Launch changed. Refresh before continuing.');
    return row;
  }
  private reserve(
    projectId: string,
    resourceId: string,
    scope: string,
    requestId: unknown,
    prepare: () => AgentLaunchContext,
  ) {
    const ownerId = this.owner();
    this.projects.getResource(projectId, resourceId);
    if (
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)
    )
      throw new BadRequestException('Invalid launch request identifier');
    const targetKey = scope.startsWith('task:')
      ? scope
      : scope.slice(0, scope.lastIndexOf(':'));
    const prior = this.db
      .select()
      .from(launches)
      .where(
        sql`${launches.scope} = ${scope} OR (${launches.projectId} = ${projectId} AND ${launches.ownerId} = ${ownerId} AND ${launches.targetKey} = ${targetKey} AND ${launches.requestId} = ${requestId}) OR (${launches.projectId} = ${projectId} AND ${launches.targetKey} = ${targetKey} AND ${inArray(launches.state, ['pending', 'needs_attention'])})`,
      )
      .orderBy(
        sql`case when ${launches.requestId} = ${requestId} and ${launches.ownerId} = ${ownerId} and ${launches.targetKey} = ${targetKey} then 0 when ${launches.scope} = ${scope} then 1 else 2 end`,
        desc(launches.createdAt),
      )
      .get();
    if (prior) {
      if (
        prior.ownerId !== ownerId ||
        prior.projectId !== projectId ||
        prior.resourceId !== resourceId
      )
        throw new ConflictException('Another user owns this launch');
      return { receipt: prior, fresh: false };
    }
    let receipt: Receipt;
    try {
      receipt = this.db.transaction((tx) => {
        // Preparation and reservation commit together, including any newly requested subtask.
        const context = prepare();
        const now = Date.now();
        return tx
          .insert(launches)
          .values({
            id: randomUUID(),
            scope,
            targetKey,
            projectId,
            resourceId,
            requestId,
            ownerId,
            context,
            taskId: context.taskId,
            state: 'pending',
            phase: 'creating',
            threadId: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
      });
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('SQLITE_CONSTRAINT')
      )
        throw new ConflictException(
          'This request or task already has a launch. Refresh to recover the existing agent.',
        );
      throw error;
    }
    return { receipt, fresh: true };
  }
  async launch(
    projectId: string,
    resourceId: string,
    taskId: string,
    input: { requestId?: unknown; expectedUpdatedAt?: unknown },
  ) {
    const ownerId = this.owner();
    this.task(projectId, resourceId, taskId);
    const associated = this.db
      .select()
      .from(launches)
      .where(
        and(eq(launches.projectId, projectId), eq(launches.taskId, taskId)),
      )
      .get();
    if (associated) {
      if (associated.ownerId !== ownerId)
        throw new ConflictException('Another user owns this launch');
      const current = this.task(projectId, resourceId, taskId);
      if (
        current.linkedThreadId &&
        current.linkedThreadId !== associated.threadId
      )
        throw new ConflictException('Task agent changed');
      if (associated.context.kind === 'deliverable')
        this.deliverables.get(
          projectId,
          associated.resourceId,
          associated.context.targetId,
        );
      return { ...this.view(associated), resumed: true };
    }
    const reservation = this.reserve(
      projectId,
      resourceId,
      `task:${taskId}`,
      input?.requestId,
      () => {
        const task = this.task(projectId, resourceId, taskId);
        if (
          !Number.isSafeInteger(input.expectedUpdatedAt) ||
          task.updatedAt !== input.expectedUpdatedAt ||
          task.linkedThreadId ||
          ['done', 'cancelled'].includes(task.subtaskStatus)
        )
          throw new ConflictException('Task changed. Reload before starting.');
        if (!task.workspacePath)
          throw new ConflictException('Select a task working folder');
        new ActiveFoldersService(this.db).validateAbsoluteSelection(
          projectId,
          task.workspacePath,
        );
        return {
          kind: 'task',
          targetId: taskId,
          targetRevision: task.updatedAt,
          taskId,
          createdSubtask: false,
          existing: false,
          cwd: task.workspacePath,
          title: task.title,
          instructions: `Exécute cette sous-tâche de projet.\nTitre : ${task.title}\nDescription : ${task.description}\nCharge estimée : ${task.estimateMinutes} minutes\nConditions de validation : ${task.validationCriteria}\nTravaille uniquement dans ${task.workspacePath}. Résume le résultat et les vérifications ; la validation finale appartient à une personne.`,
        };
      },
    );
    // Even a new request identifier cannot allocate again for the same task.
    const current = this.task(projectId, resourceId, taskId);
    if (
      current.linkedThreadId &&
      current.linkedThreadId !== reservation.receipt.threadId
    )
      throw new ConflictException(
        'Task agent changed. Refresh before continuing.',
      );
    return reservation.fresh
      ? await this.create(reservation.receipt)
      : { ...this.view(reservation.receipt), resumed: true };
  }
  async deliverable(
    projectId: string,
    resourceId: string,
    id: string,
    input: DeliverableAgentInput,
  ) {
    this.owner();
    this.deliverables.get(projectId, resourceId, id);
    if (
      !input ||
      !Number.isSafeInteger(input.version) ||
      (input.existingThreadId !== undefined &&
        (typeof input.existingThreadId !== 'string' ||
          !input.existingThreadId.trim())) ||
      (input.subtaskId !== undefined &&
        (typeof input.subtaskId !== 'string' || !input.subtaskId.trim())) ||
      (input.subtaskTitle !== undefined &&
        (typeof input.subtaskTitle !== 'string' ||
          !input.subtaskTitle.trim())) ||
      (input.subtaskId !== undefined && input.subtaskTitle !== undefined)
    )
      throw new BadRequestException(
        'Select one subtask or create one, not both',
      );
    const reservation = this.reserve(
      projectId,
      resourceId,
      `deliverable:${id}:${String(input.requestId)}`,
      input.requestId,
      () => {
        const item = this.deliverables.get(projectId, resourceId, id);
        const cwd = this.deliverables.agentWorkspace(
          projectId,
          resourceId,
          id,
          input.version,
        );
        const board = this.deliverables.board(projectId, resourceId);
        const parent = board.tasks.find(
          (task) => task.id === item.primaryTaskId,
        );
        let task:
          | {
              id: string;
              title: string;
              resourceId: string;
              parentTaskId: string | null;
              linkedThreadId?: string | null;
            }
          | undefined = input.subtaskId
          ? board.tasks.find((task) => task.id === input.subtaskId)
          : undefined;
        if (
          input.subtaskId &&
          (!parent ||
            !task ||
            task.parentTaskId !== parent.id ||
            task.linkedThreadId)
        )
          throw new ConflictException(
            'The selected execution subtask is no longer available',
          );
        if (
          task &&
          this.db
            .select({ id: launches.id })
            .from(launches)
            .where(
              and(
                eq(launches.projectId, projectId),
                eq(launches.taskId, task.id),
              ),
            )
            .get()
        )
          throw new ConflictException(
            'This subtask already has a launch. Recover its existing agent from the task manager.',
          );
        if (input.subtaskTitle !== undefined) {
          if (!parent)
            throw new ConflictException(
              'Link the deliverable to a main task before creating an execution subtask',
            );
          task = this.projects.createTask(
            projectId,
            parent.resourceId,
            {
              parentTaskId: parent.id,
              title: input.subtaskTitle,
              description: `Produire le livrable « ${item.title} ».`,
              validationCriteria: item.criteria,
              executionMode: 'agent',
            },
            {
              personId: currentAccess()?.identity.personId ?? null,
              name: currentAccess()?.identity.name ?? 'Système',
            },
          );
        }
        return {
          kind: 'deliverable',
          targetId: id,
          targetRevision: input.version,
          cwd,
          title: task?.title ?? item.title,
          taskId: task?.id ?? null,
          createdSubtask: input.subtaskTitle !== undefined,
          existing: input.existingThreadId !== undefined,
        };
      },
    );
    if (!reservation.fresh) return this.view(reservation.receipt);
    if (input.existingThreadId !== undefined) {
      // An already created agent is never allocated or archived by this path.
      let receipt = reservation.receipt;
      this.inFlight.add(receipt.id);
      try {
        await this.assertCandidate(receipt, input.existingThreadId);
        receipt = this.save(receipt, {
          threadId: input.existingThreadId,
          phase: 'created',
        });
        await this.bind(receipt);
        receipt = this.save(receipt, { phase: 'bound', state: 'ready' });
      } catch {
        receipt = this.save(receipt, { state: 'needs_attention' });
      } finally {
        this.inFlight.delete(receipt.id);
      }
      return this.view(receipt);
    }
    return this.create(reservation.receipt);
  }
  private async create(initial: Receipt) {
    let receipt = initial;
    this.inFlight.add(receipt.id);
    try {
      const started = await this.threads.startThread({
        cwd: receipt.context.cwd,
      });
      receipt = this.save(receipt, {
        threadId: started.thread.id,
        phase: 'created',
      });
      this.owner();
      await this.bind(receipt);
      receipt = this.save(receipt, { phase: 'bound' });
      if (receipt.context.kind === 'task') {
        // Persist before the external send: neither retry nor recovery resends this phase.
        receipt = this.save(receipt, { phase: 'dispatching' });
        await this.threads.startTurn({
          threadId: receipt.threadId!,
          input: [
            {
              type: 'text',
              text: receipt.context.instructions!,
              text_elements: [],
            },
          ],
        });
        receipt = this.save(receipt, {
          state: 'submitted',
          phase: 'submitted',
        });
      } else {
        receipt = this.save(receipt, { state: 'ready' });
        await this.threads
          .setThreadName(receipt.threadId!, receipt.context.title)
          .catch(() => {});
      }
    } catch {
      receipt = this.save(receipt, { state: 'needs_attention' });
    } finally {
      this.inFlight.delete(receipt.id);
    }
    return this.view(receipt);
  }
  private async bind(receipt: Receipt) {
    this.owner();
    const { context, projectId, resourceId, threadId } = receipt;
    if (!threadId) throw new ConflictException('Select the agent to recover');
    requireThreadAccess(threadId);
    if (context.kind === 'deliverable') {
      const item = this.deliverables.get(
        projectId,
        resourceId,
        context.targetId,
      );
      const already = item.conversations.some(
        (link) => link.type === 'agent' && link.id === threadId,
      );
      if (already) {
        if (
          context.taskId &&
          this.db
            .select()
            .from(projectTasks)
            .where(eq(projectTasks.id, context.taskId))
            .get()?.linkedThreadId !== threadId
        )
          throw new ConflictException(
            'Deliverable and task associations changed',
          );
        return;
      }
      if (
        this.deliverables.agentWorkspace(
          projectId,
          resourceId,
          context.targetId,
          context.targetRevision,
        ) !== context.cwd
      )
        throw new ConflictException('Working folder changed');
      this.threads.rememberInitialThreadCwd(threadId, context.cwd);
      this.deliverables.registerAgent(
        projectId,
        resourceId,
        context.targetId,
        context.targetRevision,
        threadId,
        context.taskId,
        context.existing,
      );
    } else {
      const task = this.task(projectId, resourceId, context.targetId);
      if (task.linkedThreadId === threadId) return;
      if (
        task.linkedThreadId ||
        task.updatedAt !== context.targetRevision ||
        task.workspacePath !== context.cwd
      )
        throw new ConflictException(
          'Task changed. Reload before associating this agent.',
        );
      const bound = this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, threadId))
        .get();
      if (bound && bound.projectId !== projectId)
        throw new ConflictException('Agent belongs to another project');
      if (!bound)
        await this.projects.associateAgent(
          projectId,
          threadId,
          context.cwd,
          true,
        );
      await this.projects.updateTask(projectId, resourceId, task.id, {
        expectedUpdatedAt: task.updatedAt,
        linkedThreadId: threadId,
        executionMode: 'agent',
        agentState: 'ready',
      });
    }
  }
  private associated(receipt: Receipt) {
    if (!receipt.threadId) return false;
    if (receipt.context.kind === 'task')
      return (
        this.db
          .select({ id: projectTasks.linkedThreadId })
          .from(projectTasks)
          .where(eq(projectTasks.id, receipt.context.targetId))
          .get()?.id === receipt.threadId
      );
    const item = this.deliverables.get(
      receipt.projectId,
      receipt.resourceId,
      receipt.context.targetId,
    );
    return (
      item.conversations.some(
        (link) => link.type === 'agent' && link.id === receipt.threadId,
      ) &&
      (!receipt.context.taskId ||
        this.db
          .select({ id: projectTasks.linkedThreadId })
          .from(projectTasks)
          .where(eq(projectTasks.id, receipt.context.taskId))
          .get()?.id === receipt.threadId)
    );
  }
  private async candidates(receipt: Receipt) {
    const snapshot = await this.metadata.read();
    if (snapshot.freshness.stale)
      throw new ConflictException(
        'Agent inventory is refreshing. Retry after discovery completes.',
      );
    const bindings = new Map(
      this.db
        .select()
        .from(projectAgentThreads)
        .all()
        .map((row) => [row.threadId, row.projectId]),
    );
    const assigned = new Set(
      this.db
        .select({ id: projectTasks.linkedThreadId })
        .from(projectTasks)
        .all()
        .map((row) => row.id),
    );
    for (const item of this.db
      .select({ conversations: projectDeliverables.conversations })
      .from(projectDeliverables)
      .all())
      for (const link of item.conversations)
        if (link.type === 'agent') assigned.add(link.id);
    const folders = new ActiveFoldersService(this.db);
    return snapshot.entries
      .filter(
        ({ thread, archived }) =>
          !archived &&
          ['idle', 'notLoaded'].includes(thread.status.type) &&
          canReadThread(thread.id, 'agent') &&
          thread.cwd === receipt.context.cwd &&
          (!folders.get('agent', thread.id) ||
            (folders.get('agent', thread.id)?.state === 'ready' &&
              folders.get('agent', thread.id)?.effectivePath ===
                receipt.context.cwd)) &&
          (!bindings.has(thread.id) ||
            bindings.get(thread.id) === receipt.projectId) &&
          (!assigned.has(thread.id) || thread.id === receipt.threadId),
      )
      .map(({ thread }) => ({
        id: thread.id,
        title: thread.name || thread.preview || thread.id,
      }));
  }
  private async assertCandidate(receipt: Receipt, id: string) {
    requireThreadAccess(id);
    if (
      !(await this.candidates(receipt)).some((candidate) => candidate.id === id)
    )
      throw new ConflictException(
        'Selected agent is no longer available in this working folder',
      );
  }
  async status(
    projectId: string,
    resourceId: string,
    kind: 'task' | 'deliverable',
    targetId: string,
  ) {
    const ownerId = this.owner();
    this.projects.getResource(projectId, resourceId);
    if (kind === 'task') this.task(projectId, resourceId, targetId);
    else this.deliverables.get(projectId, resourceId, targetId);
    let receipt = this.db
      .select()
      .from(launches)
      .where(
        and(
          eq(launches.projectId, projectId),
          eq(launches.ownerId, ownerId),
          kind === 'task'
            ? eq(launches.taskId, targetId)
            : and(
                eq(launches.resourceId, resourceId),
                eq(launches.targetKey, `deliverable:${targetId}`),
              ),
        ),
      )
      .orderBy(
        sql`case when ${launches.state} in ('pending','needs_attention') then 0 else 1 end`,
        desc(launches.createdAt),
      )
      .limit(1)
      .get();
    if (!receipt)
      return {
        launch: null,
        candidates: [] as Array<{ id: string; title: string }>,
      };
    if (receipt.state === 'pending' && !this.inFlight.has(receipt.id))
      receipt = this.save(receipt, { state: 'needs_attention' });
    let candidates: Array<{ id: string; title: string }> = [],
      inventoryError = false;
    if (!this.inFlight.has(receipt.id) && receipt.state === 'needs_attention') {
      try {
        candidates = await this.candidates(receipt);
      } catch {
        inventoryError = true;
      }
    }
    const targetRevision =
      receipt.context.kind === 'task'
        ? this.task(projectId, receipt.resourceId, receipt.context.targetId)
            .updatedAt
        : this.deliverables.get(
            projectId,
            receipt.resourceId,
            receipt.context.targetId,
          ).version;
    return {
      launch: {
        ...this.view(receipt),
        targetRevision,
        associationPending: Boolean(
          receipt.threadId && !this.associated(receipt),
        ),
      },
      candidates,
      inventoryError,
    };
  }
  async recover(
    projectId: string,
    resourceId: string,
    id: string,
    input: {
      action?: unknown;
      expectedUpdatedAt?: unknown;
      targetRevision?: unknown;
      threadId?: unknown;
      verified?: unknown;
    },
  ) {
    let receipt = this.get(projectId, resourceId, id);
    if (!input || !Number.isSafeInteger(input.expectedUpdatedAt))
      throw new BadRequestException('A launch revision is required');
    if (this.inFlight.has(id) || receipt.updatedAt !== input.expectedUpdatedAt)
      throw new ConflictException(
        'Launch is busy or changed. Refresh before continuing.',
      );
    if (
      !['attach', 'resume', 'acknowledge', 'keep'].includes(
        String(input.action),
      )
    )
      throw new BadRequestException('Choose a recovery action');
    if (
      ['ready', 'submitted', 'confirmed', 'abandoned'].includes(receipt.state)
    )
      return this.view(receipt);
    this.inFlight.add(id);
    try {
      if (input.action === 'keep') {
        if (!receipt.threadId || input.verified !== true)
          throw new ConflictException(
            'Verify the known agent before closing this request',
          );
        requireThreadAccess(receipt.threadId);
        receipt = this.save(receipt, {
          state: 'abandoned',
          taskId: null,
          scope: `${receipt.scope}:closed:${receipt.id}`,
        });
      } else if (input.action === 'acknowledge') {
        if (!this.associated(receipt))
          throw new ConflictException(
            'First finish the existing agent association',
          );
        if (input.verified !== true)
          throw new ConflictException(
            'Verify the conversation before confirming the send',
          );
        if (
          !receipt.threadId ||
          !['dispatching', 'submitted', 'legacy'].includes(receipt.phase)
        )
          throw new ConflictException('First associate the existing agent');
        requireThreadAccess(receipt.threadId);
        receipt = this.save(receipt, { state: 'confirmed' });
      } else {
        if (input.action === 'attach') {
          if (receipt.threadId || typeof input.threadId !== 'string')
            throw new ConflictException('Use the already known agent');
          await this.assertCandidate(receipt, input.threadId);
          receipt = this.save(receipt, {
            threadId: input.threadId,
            phase: 'created',
            context: { ...receipt.context, existing: true },
          });
        } else if (
          !receipt.threadId ||
          (!['created', 'bound'].includes(receipt.phase) &&
            !(
              ['legacy', 'dispatching'].includes(receipt.phase) &&
              !this.associated(receipt)
            ))
        )
          throw new ConflictException(
            'An uncertain send cannot be resumed automatically',
          );
        if (input.action === 'resume')
          await this.assertCandidate(receipt, receipt.threadId!);
        const currentRevision =
          receipt.context.kind === 'task'
            ? this.task(projectId, resourceId, receipt.context.targetId)
                .updatedAt
            : this.deliverables.get(
                projectId,
                resourceId,
                receipt.context.targetId,
              ).version;
        if (input.targetRevision !== currentRevision)
          throw new ConflictException(
            'Target changed. Refresh before associating the agent',
          );
        receipt = this.save(receipt, {
          context: { ...receipt.context, targetRevision: currentRevision },
        });
        if (receipt.context.existing) {
          if (!this.mutations)
            throw new ConflictException(
              'The existing-agent mutation gate is unavailable',
            );
          await this.mutations.mutate(() => this.bind(receipt));
        } else await this.bind(receipt);
        // Association recovery deliberately leaves sending to the existing conversation.
        const uncertain =
          input.action === 'resume' &&
          ['legacy', 'dispatching'].includes(receipt.phase);
        receipt = this.save(receipt, {
          phase: uncertain ? receipt.phase : 'bound',
          state: uncertain ? 'needs_attention' : 'confirmed',
        });
      }
    } catch (error) {
      receipt = this.save(receipt, { state: 'needs_attention' });
      throw error;
    } finally {
      this.inFlight.delete(id);
    }
    return this.view(receipt);
  }
}
