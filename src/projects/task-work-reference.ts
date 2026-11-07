import { canAccessDeliverable } from '../deliverables/deliverable-access';
/** A deliverable link replaces the main task's direct folder reference. */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import {
  projectTasks,
  projectDeliverables,
  projectResources,
} from '../database/schema';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { assertPrimaryTask } from './project-work-links';

export type TaskWorkReferenceInput =
  | { type: 'folder'; path: string | null }
  | { type: 'deliverable'; deliverableId: string; expectedVersion: number };

export function taskWorkReference(
  db: AppDatabase,
  task: typeof projectTasks.$inferSelect,
) {
  const main = task.parentTaskId
    ? db
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.id, task.parentTaskId))
        .get()!
    : task;
  const deliverable = db
    .select()
    .from(projectDeliverables)
    .where(eq(projectDeliverables.primaryTaskId, main.id))
    .get();
  if (
    deliverable &&
    !canAccessDeliverable(
      db,
      db
        .select()
        .from(projectResources)
        .where(eq(projectResources.id, deliverable.resourceId))
        .get()!.projectId,
      deliverable,
    )
  ) {
    return {
      type: 'deliverable' as const,
      deliverableId: undefined,
      resourceId: undefined,
      title: undefined,
      version: undefined,
      path: null,
      activeFolder: null,
    };
  }
  const folders = new ActiveFoldersService(db);
  const folder = folders.get(
    deliverable ? 'deliverable' : 'task',
    deliverable?.id ?? main.id,
  );
  return deliverable
    ? {
        type: 'deliverable' as const,
        deliverableId: deliverable.id,
        resourceId: deliverable.resourceId,
        title: deliverable.title,
        version: deliverable.version,
        path: folder?.state === 'ready' ? folder.effectivePath : null,
        activeFolder: folder,
      }
    : {
        type: 'folder' as const,
        path: main.workspacePath,
        activeFolder: folder,
      };
}

/** Called inside the caller's transaction, after the deliverable link has changed. */
export function normalizeDeliverableTaskReference(
  db: AppDatabase,
  taskId: string,
  changed = false,
) {
  const task = db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.id, taskId))
    .get();
  if (!task) return;
  const linked = db
    .select()
    .from(projectDeliverables)
    .where(eq(projectDeliverables.primaryTaskId, taskId))
    .get();
  if (!linked && !changed) return;
  const children = db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.parentTaskId, taskId))
    .all();
  const ids = [taskId, ...children.map((child) => child.id)];
  db.update(projectTasks)
    .set({
      workspacePath: null,
      updatedAt: sql`max(${projectTasks.updatedAt}+1, ${Date.now()})`,
    })
    .where(
      and(
        inArray(projectTasks.id, ids),
        ...(changed ? [] : [isNotNull(projectTasks.workspacePath)]),
      ),
    )
    .run();
  const folders = new ActiveFoldersService(db);
  for (const id of ids) folders.removeContext('task', id);
}

export function applyTaskWorkReference(
  db: AppDatabase,
  projectId: string,
  taskId: string,
  input: TaskWorkReferenceInput,
) {
  const task = db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.id, taskId))
    .get();
  if (!task || task.parentTaskId)
    throw new BadRequestException('Only main tasks select a work reference');
  if (!input || !['folder', 'deliverable'].includes(input.type))
    throw new BadRequestException('Invalid task work reference');
  const current = db
    .select()
    .from(projectDeliverables)
    .where(eq(projectDeliverables.primaryTaskId, taskId))
    .get();
  if (current && !canAccessDeliverable(db, projectId, current))
    throw new NotFoundException('Deliverable not found');
  if (input.type === 'deliverable') {
    const target = db
      .select({ item: projectDeliverables, resource: projectResources })
      .from(projectDeliverables)
      .innerJoin(
        projectResources,
        eq(projectResources.id, projectDeliverables.resourceId),
      )
      .where(eq(projectDeliverables.id, input.deliverableId))
      .get();
    if (
      !target ||
      target.resource.projectId !== projectId ||
      target.resource.type !== 'deliverable_board'
    )
      throw new BadRequestException('Select a deliverable from this project');
    if (!canAccessDeliverable(db, projectId, target.item))
      throw new NotFoundException('Deliverable not found');
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      target.item.version !== input.expectedVersion
    )
      throw new ConflictException('Deliverable changed. Reload before saving.');
    if (current?.id === target.item.id) {
      normalizeDeliverableTaskReference(db, taskId);
      return;
    }
    if (
      target.item.lifecycleStatus === 'archived' ||
      (target.item.primaryTaskId && target.item.primaryTaskId !== taskId)
    )
      throw new ConflictException('Deliverable is not available');
    if (current?.lifecycleStatus === 'archived')
      throw new ConflictException('Archived deliverables are read-only');
    if (current)
      db.update(projectDeliverables)
        .set({
          primaryTaskId: null,
          version: current.version + 1,
          updatedAt: Date.now(),
        })
        .where(eq(projectDeliverables.id, current.id))
        .run();
    assertPrimaryTask(db, projectId, taskId, target.item.id);
    db.update(projectDeliverables)
      .set({
        primaryTaskId: taskId,
        version: target.item.version + 1,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(projectDeliverables.id, target.item.id),
          eq(projectDeliverables.version, input.expectedVersion),
        ),
      )
      .run();
    normalizeDeliverableTaskReference(db, taskId, true);
  } else {
    if (current?.lifecycleStatus === 'archived')
      throw new ConflictException('Archived deliverables are read-only');
    if (current)
      db.update(projectDeliverables)
        .set({
          primaryTaskId: null,
          version: current.version + 1,
          updatedAt: Date.now(),
        })
        .where(eq(projectDeliverables.id, current.id))
        .run();
    db.update(projectTasks)
      .set({ workspacePath: input.path })
      .where(eq(projectTasks.id, taskId))
      .run();
    db.update(projectTasks)
      .set({
        workspacePath: input.path,
        updatedAt: sql`max(${projectTasks.updatedAt}+1, ${Date.now()})`,
      })
      .where(eq(projectTasks.parentTaskId, taskId))
      .run();
    if (!input.path) {
      const folders = new ActiveFoldersService(db);
      folders.removeContext('task', taskId);
      for (const child of db
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.parentTaskId, taskId))
        .all())
        folders.removeContext('task', child.id);
    }
  }
}

export function assertWorkReferenceAgentLinks(
  db: AppDatabase,
  mainTaskId: string,
) {
  const children = db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.parentTaskId, mainTaskId))
    .all();
  const deliverables = db.select().from(projectDeliverables).all();
  for (const child of children) {
    if (!child.linkedThreadId) continue;
    if (
      deliverables.some(
        (item) =>
          item.primaryTaskId !== mainTaskId &&
          item.conversations.some(
            (link) => link.type === 'agent' && link.id === child.linkedThreadId,
          ),
      )
    )
      throw new ConflictException(
        'Remove incompatible agent assignments before changing the work reference',
      );
  }
  const linked = deliverables.find((item) => item.primaryTaskId === mainTaskId);
  for (const link of linked?.conversations ?? []) {
    if (link.type !== 'agent') continue;
    const assigned = db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.linkedThreadId, link.id))
      .all();
    if (assigned.some((task) => task.parentTaskId !== mainTaskId))
      throw new ConflictException(
        'Remove incompatible agent assignments before changing the work reference',
      );
  }
}

export function validateTaskWorkReference(
  input: unknown,
): asserts input is TaskWorkReferenceInput {
  if (!input || typeof input !== 'object')
    throw new BadRequestException('Invalid task work reference');
  const ref = input as Record<string, unknown>;
  if (
    ref.type === 'folder' &&
    (ref.path === null || typeof ref.path === 'string')
  )
    return;
  if (
    ref.type === 'deliverable' &&
    typeof ref.deliverableId === 'string' &&
    ref.deliverableId.trim() &&
    Number.isSafeInteger(ref.expectedVersion)
  )
    return;
  throw new BadRequestException('Invalid task work reference');
}

export function assertDeliverableWorkReference(
  db: AppDatabase,
  item: typeof projectDeliverables.$inferSelect,
) {
  const roots = new Set<string>();
  if (item.primaryTaskId) roots.add(item.primaryTaskId);
  for (const link of item.conversations) {
    if (link.type !== 'agent') continue;
    const assigned = db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.linkedThreadId, link.id))
      .all();
    for (const task of assigned)
      if (task.parentTaskId) roots.add(task.parentTaskId);
  }
  for (const root of roots) assertWorkReferenceAgentLinks(db, root);
}
