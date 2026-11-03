import { z } from 'zod';
import {
  projectMediaReadInput,
  projectMediaReadToolInput,
  projectMediaManageInput,
  projectMediaManageToolInput,
} from './project-media.schema';
const jobId = '12345678-1234-4234-8234-123456789012';
describe('MCP media wire schema', () => {
  it.each([projectMediaReadToolInput, projectMediaManageToolInput])(
    'advertises a root object with explicit operations',
    (schema) => {
      const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
      expect(json.type).toBe('object');
      expect(json.properties?.operation).toBeDefined();
      expect(json.additionalProperties).toBe(false);
    },
  );
  it('enforces the same read variants including forbidden fields', () => {
    for (const value of [
      { operation: 'status' },
      { operation: 'job', jobId },
      { operation: 'documents', resourceId: 'r', deliverableId: 'd' },
      { operation: 'status', jobId },
      { operation: 'documents' },
      { operation: 'job', jobId, path: '/etc/passwd' },
    ])
      expect(projectMediaReadToolInput.safeParse(value).success).toBe(
        projectMediaReadInput.safeParse(value).success,
      );
  });
  it('enforces the same write variants without loosening cancel or publish', () => {
    for (const value of [
      { operation: 'cancel', jobId },
      { operation: 'cancel', jobId, requestId: 'unexpected' },
      {
        operation: 'publish',
        jobId,
        requestId: 'publish',
        target: { resourceId: 'r', deliverableId: 'd' },
        userRequest: 'Publish audio',
      },
      {
        operation: 'start',
        requestId: 'extract',
        mode: 'extract',
        source: {
          resourceId: 'r',
          deliverableId: 'd',
          documentId: 'video',
          versionId: 'v1',
        },
        userRequest: 'Extract audio',
      },
      {
        operation: 'start',
        requestId: 'missing-source',
        mode: 'extract',
        userRequest: 'Extract',
      },
      {
        operation: 'publish',
        jobId,
        target: { resourceId: 'r', deliverableId: 'd' },
      },
    ])
      expect(projectMediaManageToolInput.safeParse(value).success).toBe(
        projectMediaManageInput.safeParse(value).success,
      );
  });
});
