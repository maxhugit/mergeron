import { z } from 'zod';

const id = z.string().min(1).max(100);
const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export const listProjectConnectionsInput = z.strictObject({
  query: z.string().max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
export const readProjectGitInput = z.strictObject({
  connectionId: id,
  operation: z.enum([
    'branches',
    'files',
    'pull_requests',
    'checks',
    'local_status',
    'local_diff',
    'local_commits',
  ]),
  copyId: id.optional(),
  path: z.string().max(2048).optional(),
  ref: revision.optional(),
  number: z.number().int().min(1).max(999999999).optional(),
});
export const publishProjectGitInput = z.strictObject({
  connectionId: id,
  copyId: id,
  operation: z.enum(['push', 'create_pull_request']),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  userRequest: z.string().trim().min(1).max(2000),
  expectedHead: revision,
  expectedBranch: z.string().min(1).max(200),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  base: z.string().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(256).optional(),
  description: z.string().max(10000).optional(),
  draft: z.boolean().optional(),
});
export const projectConnectionTools = [
  'list_project_connections',
  'read_project_git',
  'publish_project_git',
] as const;
