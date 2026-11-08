/** Shared business relationships. Browsing folders never creates these links. */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import {
  projectAgentThreads,
  projectDeliverables,
  projectResources,
  projectTasks,
} from '../database/schema';
import { requireThreadAccess, canReadThread } from '../auth/access-context';

export function assertPrimaryTask(
  db: AppDatabase,
  projectId: string,
  taskId: string,
  deliverableId?: string,
) {
  const task = db
    .select({ task: projectTasks, projectId: projectResources.projectId })
    .from(projectTasks)
    .innerJoin(
      projectResources,
      eq(projectTasks.resourceId, projectResources.id),
    )
    .where(eq(projectTasks.id, taskId))
    .get();
  if (!task || task.projectId !== projectId || task.task.parentTaskId)
    throw new BadRequestException(
      'Primary task must be a main task in this project',
    );
  if (
    db
      .select({ id: projectDeliverables.id })
      .from(projectDeliverables)
      .where(
        and(
          eq(projectDeliverables.primaryTaskId, taskId),
          deliverableId ? ne(projectDeliverables.id, deliverableId) : undefined,
        ),
      )
      .get()
  )
    throw new ConflictException('This task already has a primary deliverable');
}

export function assertTaskAgent(
  db: AppDatabase,
  projectId: string,
  taskId: string,
  threadId: string,
  parentTaskId: string | null,
) {
  requireThreadAccess(threadId);
  const binding = db
    .select()
    .from(projectAgentThreads)
    .where(eq(projectAgentThreads.threadId, threadId))
    .get();
  if (!binding || binding.projectId !== projectId)
    throw new BadRequestException('Agent must belong to this project');
  if (!parentTaskId)
    throw new BadRequestException('Only subtasks can be assigned to an agent');
  if (
    db
      .select({ id: projectTasks.id })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.linkedThreadId, threadId),
          ne(projectTasks.id, taskId),
          sql`(${projectTasks.parentTaskId} is null or ${projectTasks.parentTaskId} != ${parentTaskId})`,
        ),
      )
      .get()
  )
    throw new ConflictException(
      'This agent is assigned to subtasks of another main task',
    );
}

/** Explicit dual assignments must share the same main task. */
export function assertDeliverableAgentLinks(
  db: AppDatabase,
  projectId: string,
  primaryTaskId: string | null,
  agentIds: string[],
  deliverableId?: string,
) {
  for (const threadId of agentIds) {
    if (
      db
        .select({ id: projectDeliverables.id })
        .from(projectDeliverables)
        .where(
          and(
            deliverableId
              ? ne(projectDeliverables.id, deliverableId)
              : undefined,
            sql`exists (select 1 from json_each(${projectDeliverables.conversations}) where json_extract(value, '$.type') = 'agent' and json_extract(value, '$.id') = ${threadId})`,
          ),
        )
        .get()
    )
      throw new ConflictException(
        'This agent already belongs to another deliverable',
      );

    const binding = db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    if (!binding || binding.projectId !== projectId)
      throw new BadRequestException('Agent must belong to this project');
    const assigned = db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.linkedThreadId, threadId))
      .all();
    if (
      assigned.some(
        (task) => !primaryTaskId || task.parentTaskId !== primaryTaskId,
      )
    )
      throw new ConflictException(
        'Agent subtask and deliverable must share the same main task',
      );
  }
}

export function assertTaskDeliverableLinks(
  db: AppDatabase,
  threadId: string,
  parentTaskId: string | null,
) {
  const incompatible = db
    .select({ id: projectDeliverables.id })
    .from(projectDeliverables)
    .where(
      and(
        sql`exists (select 1 from json_each(${projectDeliverables.conversations}) where json_extract(value, '$.type') = 'agent' and json_extract(value, '$.id') = ${threadId})`,
        parentTaskId
          ? sql`(${projectDeliverables.primaryTaskId} is null or ${projectDeliverables.primaryTaskId} != ${parentTaskId})`
          : undefined,
      ),
    )
    .get();
  if (incompatible)
    throw new ConflictException(
      'Agent subtask and deliverable must share the same main task',
    );
}

export function projectAgentLinks(db: AppDatabase, projectId: string) {
  let bindings: Set<string> | undefined;
  let tasks:
    | Array<{ id: string; parentId: string | null; threadId: string | null }>
    | undefined;
  return (
    item: Pick<
      typeof projectDeliverables.$inferSelect,
      'primaryTaskId' | 'conversations'
    >,
  ): string[] => {
    bindings ??= new Set(
      db
        .select({ id: projectAgentThreads.threadId })
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.projectId, projectId))
        .all()
        .map((row) => row.id),
    );
    if (item.primaryTaskId)
      tasks ??= db
        .select({
          id: projectTasks.id,
          parentId: projectTasks.parentTaskId,
          threadId: projectTasks.linkedThreadId,
        })
        .from(projectTasks)
        .innerJoin(
          projectResources,
          eq(projectTasks.resourceId, projectResources.id),
        )
        .where(eq(projectResources.projectId, projectId))
        .all();
    const inherited = item.primaryTaskId
      ? tasks!
          .filter(
            (task) =>
              task.id === item.primaryTaskId ||
              task.parentId === item.primaryTaskId,
          )
          .map((task) => task.threadId)
      : [];
    return [
      ...new Set([
        ...item.conversations
          .filter((link) => link.type === 'agent')
          .map((link) => link.id),
        ...inherited,
      ]),
    ].filter((id): id is string =>
      Boolean(id && bindings!.has(id) && canReadThread(id, 'agent')),
    );
  };
}
