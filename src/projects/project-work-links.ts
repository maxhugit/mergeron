/** Shared business relationships. Browsing folders never creates these links. */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
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
) {
  requireThreadAccess(threadId);
  const binding = db
    .select()
    .from(projectAgentThreads)
    .where(eq(projectAgentThreads.threadId, threadId))
    .get();
  if (!binding || binding.projectId !== projectId)
    throw new BadRequestException('Agent must belong to this project');
  if (
    db
      .select({ id: projectTasks.id })
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.linkedThreadId, threadId),
          ne(projectTasks.id, taskId),
        ),
      )
      .get()
  )
    throw new ConflictException('This agent already belongs to another task');
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
