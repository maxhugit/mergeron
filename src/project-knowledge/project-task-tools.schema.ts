import { z } from 'zod';

const id = z.string().trim().min(1).max(100);
const date = z
  .number()
  .int()
  .nonnegative()
  .max(8_640_000_000_000_000)
  .nullable();
export const taskChanges = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
  validationCriteria: z.string().max(10_000).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  subtaskStatus: z
    .enum(['todo', 'started', 'review', 'done', 'cancelled'])
    .optional(),
  statusId: id.optional(),
  priority: id.optional(),
  estimateMinutes: z.number().int().min(0).max(525_600).optional(),
  startAt: date.optional(),
  dueAt: date.optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  dependencyIds: z.array(id).max(50).optional(),
});
const common = {
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  resourceId: id,
  id,
  expectedUpdatedAt: z
    .number()
    .int()
    .positive()
    .safe()
    .describe(
      'Task revision observed with project_task_get, not a guessed timestamp.',
    ),
  userRequest: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      'Explicit human request; this explanation grants no additional permissions.',
    ),
};
// MCP advertises a root object; operation-specific constraints are enforced again server-side.
export const taskManageInput = z
  .strictObject({
    ...common,
    operation: z.enum(['update', 'attach_self', 'detach_self']),
    changes: taskChanges.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.operation === 'update'
        ? !value.changes || !Object.keys(value.changes).length
        : value.changes !== undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Changes are required only for update',
      });
  });
export const taskReadOutput = z.object({
  id,
  resourceId: id,
  title: z.string(),
  description: z.string(),
  status: z.string().nullable(),
  statusId: id,
  parentTaskId: id.nullable(),
  linkedThreadId: id.nullable(),
  validationCriteria: z.string(),
  progress: z.number().int(),
  subtaskStatus: z.string(),
  updatedAt: z.number().int(),
  priority: z.string(),
  estimateMinutes: z.number().int(),
  startAt: z.number().nullable(),
  dueAt: z.number().nullable(),
  labels: z.array(z.string()),
  availablePriorities: z.array(z.string()),
  dependencyIds: z.array(id),
  progressIsDerived: z.boolean(),
  availableStatuses: z.array(
    z.object({ id, name: z.string(), kind: z.string() }),
  ),
});
export const taskManageOutput = z.object({
  status: z.enum([
    'updated',
    'attached',
    'detached',
    'already_attached',
    'already_detached',
  ]),
  replayed: z.boolean(),
  task: taskReadOutput,
  url: z.string(),
});
