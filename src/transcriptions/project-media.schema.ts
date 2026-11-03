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
