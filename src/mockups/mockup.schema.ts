import { z } from 'zod';
export const MAX_MOCKUP_BYTES = 24 * 1024;
export const MAX_PROJECT_MOCKUP_BYTES = 8 * 1024 * 1024;
export const MAX_MOCKUP_REVISIONS = 100;
const id = z.uuid();
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const mockupCreateInput = z.strictObject({
  requestId,
  title: z.string().trim().min(1).max(160),
  html: z.string().min(1).max(MAX_MOCKUP_BYTES),
});
export const mockupUpdateInput = mockupCreateInput.extend({
  id,
  baseRevision: id,
});
export const mockupReadInput = z.strictObject({ id, revision: id.optional() });
export const mockupListInput = z.strictObject({});
export const mockupPublishInput = z
  .strictObject({
    ...mockupReadInput.shape,
    revision: id,
    requestId,
    resourceId: z.string().min(1).max(100),
    deliverableId: z.string().min(1).max(100),
    documentId: z.string().min(1).max(100).optional(),
    expectedVersion: z.number().int().min(1).optional(),
    userRequest: z.string().trim().min(1).max(2000),
  })
  .superRefine((value, context) => {
    if (Boolean(value.documentId) !== (value.expectedVersion !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'documentId and expectedVersion must be supplied together',
      });
  });
