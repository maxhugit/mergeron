import { z } from 'zod';
const id = z.string().min(1).max(100);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const target = z.strictObject({ resourceId: id, deliverableId: id });
export const projectMediaReadInput = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('status') }),
  z.strictObject({ operation: z.literal('documents'), ...target.shape }),
  z.strictObject({
    operation: z.literal('job'),
    jobId: z.uuid(),
    offset: z.number().int().min(0).max(50000).optional(),
  }),
]);
export const projectMediaManageInput = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('start'),
    requestId,
    mode: z.enum(['extract', 'transcribe', 'both']),
    source: z.strictObject({ ...target.shape, documentId: id, versionId: id }),
    userRequest: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({
    operation: z.literal('publish'),
    requestId,
    jobId: z.uuid(),
    target,
    userRequest: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({ operation: z.literal('cancel'), jobId: z.uuid() }),
]);

// The native MCP SDK requires an object at the root to advertise its fields.
// Keep the discriminated domain variants as the authoritative runtime validator.
export const projectMediaReadToolInput = z
  .strictObject({
    operation: z.enum(['status', 'documents', 'job']),
    resourceId: id.optional().describe('Required only for documents.'),
    deliverableId: id.optional().describe('Required only for documents.'),
    jobId: z.uuid().optional().describe('Required only for job.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(50000)
      .optional()
      .describe('Only for job; returns at most 100 segments.'),
  })
  .superRefine((value, context) => {
    if (!projectMediaReadInput.safeParse(value).success)
      context.addIssue({
        code: 'custom',
        message: 'Invalid arguments for this operation.',
      });
  });
export const projectMediaManageToolInput = z
  .strictObject({
    operation: z.enum(['start', 'publish', 'cancel']),
    requestId: requestId
      .optional()
      .describe('Required for start and publish; reuse unchanged on retries.'),
    mode: z
      .enum(['extract', 'transcribe', 'both'])
      .optional()
      .describe('Required only for start.'),
    source: z
      .strictObject({ ...target.shape, documentId: id, versionId: id })
      .optional()
      .describe(
        'Required only for start; an observed immutable document version.',
      ),
    jobId: z.uuid().optional().describe('Required for publish and cancel.'),
    target: target
      .optional()
      .describe('Required only for publish; an existing deliverable.'),
    userRequest: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('Required for start and publish; explicit human request.'),
  })
  .superRefine((value, context) => {
    if (!projectMediaManageInput.safeParse(value).success)
      context.addIssue({
        code: 'custom',
        message: 'Invalid arguments for this operation.',
      });
  });
