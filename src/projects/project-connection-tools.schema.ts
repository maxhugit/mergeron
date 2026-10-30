import { z } from 'zod';

const id = z.string().min(1).max(100);
const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export const listProjectConnectionsInput = z.strictObject({
  query: z.string().max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
/** Ownership and target paths are always selected by the server. */
export const createProjectGitCopyInput = z.strictObject({
  connectionId: id,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  branch: z.string().trim().min(1).max(200).optional(),
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
    'local_staged_diff',
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
/** Local mutations never accept shell commands, author identity or repository URLs. */
const localContext = {
  connectionId: id,
  copyId: id,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  userRequest: z.string().trim().min(1).max(2000),
  expectedHead: revision,
  expectedBranch: z.string().min(1).max(200),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
const paths = z.array(z.string().min(1).max(2048)).min(1).max(100);
// The MCP SDK requires an object at the schema root. Operation-dependent
// requirements are validated again with the strict union at execution time.
export const prepareProjectGitInput = z.strictObject({
  ...localContext,
  operation: z.enum([
    'stage_review',
    'stage',
    'unstage',
    'commit',
    'create_branch',
  ]),
  paths: paths.optional(),
  reviewFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  message: z.string().trim().min(1).max(4000).optional(),
  name: z.string().min(1).max(200).optional(),
});
export const prepareProjectGitOperationInput = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      ...localContext,
      operation: z.literal('stage_review'),
      paths,
    }),
    z.strictObject({
      ...localContext,
      operation: z.literal('stage'),
      paths,
      reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    z.strictObject({ ...localContext, operation: z.literal('unstage'), paths }),
    z.strictObject({
      ...localContext,
      operation: z.literal('commit'),
      message: z.string().trim().min(1).max(4000),
    }),
    z.strictObject({
      ...localContext,
      operation: z.literal('create_branch'),
      name: z.string().min(1).max(200),
    }),
  ],
);
export const projectConnectionTools = [
  'list_project_connections',
  'create_project_git_copy',
  'read_project_git',
  'publish_project_git',
  'prepare_project_git',
] as const;
