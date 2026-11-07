import { ActiveFoldersService } from '../active-folders/active-folders.service';
/** One durable launch per task. Never replay an uncertain native start. */
import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { projectTasks, projectTaskLaunches } from '../database/schema';
import {
  currentAccess,
  requireExecutionAccess,
  requireThreadAccess,
} from '../auth/access-context';
import { ThreadsService } from '../threads/threads.service';
import { ProjectsService } from './projects.service';

@Injectable()
export class TaskAgentLaunchService {
  constructor(
    @Inject(DRIZZLE_DB) private db: AppDatabase,
    private projects: ProjectsService,
    private threads: ThreadsService,
  ) {}
  async launch(
    projectId: string,
    resourceId: string,
    taskId: string,
    input: { requestId?: unknown; expectedUpdatedAt?: unknown },
  ) {
    requireExecutionAccess();
    const access = currentAccess();
    if (!access)
      throw new ForbiddenException('An authenticated identity is required');
    access.identities.requireActive(access.identity);
    this.projects.getResource(projectId, resourceId);
    if (
      typeof input?.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId) ||
      !Number.isSafeInteger(input.expectedUpdatedAt)
    )
      throw new BadRequestException('Invalid task launch request');
    const ownerId =
      access.identity.personId ??
      access.identity.subject ??
      access.identity.kind;
    const key = eq(projectTaskLaunches.taskId, taskId);
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
    if (!task || !task.parentTaskId || task.executionMode !== 'agent')
      throw new BadRequestException('Select an agent execution subtask');
    const prior = this.db.select().from(projectTaskLaunches).where(key).get();
    if (prior) {
      if (prior.ownerId !== ownerId)
        throw new ConflictException('Task launch belongs to another user');
      if (!prior.threadId)
        throw new ConflictException(
          'TASK_LAUNCH_UNCONFIRMED: inspect the agent list before any new launch',
        );
      if (task.linkedThreadId && task.linkedThreadId !== prior.threadId)
        throw new ConflictException(
          'Task agent changed. Reload before continuing.',
        );
      requireThreadAccess(prior.threadId);
      return { threadId: prior.threadId, state: prior.state, resumed: true };
    }
    if (
      task.linkedThreadId ||
      task.updatedAt !== input.expectedUpdatedAt ||
      ['done', 'cancelled'].includes(task.subtaskStatus)
    )
      throw new ConflictException('Task changed. Reload before starting.');
    // Validate the selected scope before allocating any native resource.
    const cwd = task.workspacePath;
    if (!cwd) throw new ConflictException('Select a task working folder');
    new ActiveFoldersService(this.db).validateAbsoluteSelection(projectId, cwd);
    this.db
      .insert(projectTaskLaunches)
      .values({
        taskId,
        projectId,
        requestId: input.requestId,
        ownerId,
        state: 'creating',
        updatedAt: Date.now(),
      })
      .run();
    let threadId: string | undefined;
    try {
      const started = await this.threads.startThread({ cwd });
      threadId = started.thread.id;
      access.identities.requireActive(access.identity);
      const receipt = this.db
        .update(projectTaskLaunches)
        .set({ threadId, state: 'created', updatedAt: Date.now() })
        .where(key)
        .run();
      if (!receipt.changes)
        throw new ConflictException('Task launch was removed');
      await this.projects.associateAgent(projectId, threadId, cwd, true);
      await this.projects.updateTask(projectId, resourceId, taskId, {
        expectedUpdatedAt: task.updatedAt,
        linkedThreadId: threadId,
        executionMode: 'agent',
        agentState: 'ready',
      });
      // Persist uncertainty before the external send. An RPC error can mean the turn started.
      this.db
        .update(projectTaskLaunches)
        .set({ state: 'dispatching', updatedAt: Date.now() })
        .where(key)
        .run();
      await this.threads.startTurn({
        threadId,
        input: [
          {
            type: 'text',
            text: `Exécute cette sous-tâche de projet.\nTitre : ${task.title}\nDescription : ${task.description}\nConditions de validation : ${task.validationCriteria}\nTravaille dans ${cwd}. Résume le résultat et les vérifications ; la validation finale appartient à une personne.`,
            text_elements: [],
          },
        ],
      });
      this.db
        .update(projectTaskLaunches)
        .set({ state: 'submitted', updatedAt: Date.now() })
        .where(key)
        .run();
      return { threadId, state: 'submitted', resumed: false };
    } catch {
      this.db
        .update(projectTaskLaunches)
        .set({ state: 'needs_attention', updatedAt: Date.now() })
        .where(key)
        .run();
      if (threadId) {
        // Preserve a visible recovery handle, even when association or the first send failed.
        return { threadId, state: 'needs_attention', resumed: false };
      }
      throw new ConflictException(
        'TASK_LAUNCH_UNCONFIRMED: inspect the agent list before any new launch',
      );
    }
  }
}
