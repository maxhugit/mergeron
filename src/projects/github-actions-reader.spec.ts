import { afterEach, expect, it, vi } from 'vitest';
import { readGitHubActions } from './github-actions-reader';
import { WorkspaceGitService } from './workspace-git.service';
import type { WorkspaceResourcesService } from './workspace-resources.service';
import type { WorkspaceCopiesService } from './workspace-copies.service';

const revision = 'a'.repeat(40);
const runId = 43398956550;
const jobId = 131796715224;
const run = {
  id: runId,
  name: 'Publish',
  head_sha: revision,
  head_branch: 'v0.8.3',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 2,
};
const job = {
  id: jobId,
  run_id: runId,
  run_attempt: 2,
  name: 'build',
  status: 'completed',
  conclusion: 'failure',
  steps: [
    { number: 3, name: 'Compile', status: 'completed', conclusion: 'failure' },
  ],
};
const log = vi.fn(() =>
  Promise.resolve({ text: 'Compilation failed', truncated: false }),
);
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const read = (
  query: Parameters<typeof readGitHubActions>[1],
  get: (endpoint: string) => Promise<unknown>,
  active = () => {},
) =>
  readGitHubActions(
    'owner/repo',
    query,
    get as <T>(endpoint: string) => Promise<T>,
    log,
    active,
  );

it('lists push/tag/manual runs without requiring or filtering on pull requests and encodes filters', async () => {
  const get = vi.fn(() =>
    Promise.resolve({ total_count: 60, workflow_runs: [run] }),
  );
  const result = await read(
    {
      operation: 'workflow_runs',
      branch: 'release/a&event=pull_request',
      event: 'push',
      status: 'failure',
      ref: revision,
    },
    get,
  );
  expect(get).toHaveBeenCalledExactlyOnceWith(
    `actions/runs?per_page=50&page=1&head_sha=${revision}&branch=release%2Fa%26event%3Dpull_request&event=push&status=failure`,
  );
  expect(result).toMatchObject({
    limited: true,
    total: 60,
    nextPage: 2,
    items: [
      {
        id: runId,
        branch: 'v0.8.3',
        event: 'push',
        attempt: 2,
        conclusion: 'failure',
        url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
    ],
  });
  expect(log).not.toHaveBeenCalled();
});

it('reads a selected run/attempt and bounds jobs, steps and pagination', async () => {
  const get = vi.fn((path: string) =>
    Promise.resolve(
      path.includes('/jobs?')
        ? {
            total_count: 1,
            jobs: [
              {
                ...job,
                steps: Array.from({ length: 201 }, () => job.steps[0]),
              },
            ],
          }
        : run,
    ),
  );
  expect(
    await read({ operation: 'workflow_run', runId, attempt: 2 }, get),
  ).toMatchObject({ id: runId, revision, attempt: 2 });
  expect(get).toHaveBeenCalledWith(`actions/runs/${runId}/attempts/2`);
  const jobs = await read(
    { operation: 'workflow_jobs', runId, attempt: 2 },
    get,
  );
  expect(jobs).toMatchObject({
    items: [{ id: jobId, stepsLimited: true, conclusion: 'failure' }],
  });
  expect(
    (jobs as { items: { steps: unknown[] }[] }).items[0].steps,
  ).toHaveLength(200);
  expect(get).toHaveBeenCalledWith(
    `actions/runs/${runId}/attempts/2/jobs?per_page=50&page=1`,
  );
});

it('verifies job ownership before downloading logs and rechecks authority after asynchronous reads', async () => {
  const get = vi.fn(() => Promise.resolve(job));
  expect(
    await read({ operation: 'workflow_job_logs', runId, jobId }, get),
  ).toMatchObject({ text: 'Compilation failed', runId, jobId, attempt: 2 });
  expect(log).toHaveBeenCalledExactlyOnceWith(jobId);
  log.mockClear();
  await expect(
    read({ operation: 'workflow_job_logs', runId: runId + 1, jobId }, get),
  ).rejects.toThrow('GIT_GITHUB_JOB_MISMATCH');
  expect(log).not.toHaveBeenCalled();
  let active = true;
  await expect(
    read(
      { operation: 'workflow_job_logs', runId, jobId },
      () => {
        active = false;
        return Promise.resolve(job);
      },
      () => {
        if (!active) throw new Error('revoked');
      },
    ),
  ).rejects.toThrow('revoked');
  expect(log).not.toHaveBeenCalled();
});

it.each([
  { operation: 'workflow_run' },
  { operation: 'workflow_job_logs', runId },
  { operation: 'workflow_jobs', runId: -1 },
  { operation: 'workflow_run', runId, attempt: 0 },
  { operation: 'workflow_runs', page: 21 },
])(
  'refuses missing or invalid IDs/paging before any request: %j',
  async (query) => {
    const get = vi.fn();
    await expect(read(query, get)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  },
);

it('does not report malformed provider responses as empty or successful', async () => {
  await expect(
    read({ operation: 'workflow_runs' }, () =>
      Promise.resolve({ workflow_runs: [] }),
    ),
  ).rejects.toThrow('GIT_GITHUB_INVALID_RESPONSE');
  await expect(
    read({ operation: 'workflow_jobs', runId, attempt: 1 }, () =>
      Promise.resolve({ total_count: 1, jobs: [job] }),
    ),
  ).rejects.toThrow('GIT_GITHUB_INVALID_RESPONSE');
  await expect(
    read({ operation: 'workflow_run', runId }, () =>
      Promise.resolve({ ...run, id: runId + 1 }),
    ),
  ).rejects.toThrow('GIT_GITHUB_INVALID_RESPONSE');
});

it('uses only the registered repository and its server-held token, without a local copy or open PR', async () => {
  const resolve = vi.fn(() => ({
    resource: {
      enabled: true,
      type: 'git',
      address: 'https://github.com/owner/repo.git',
    },
    secret: { token: 'private-token' },
  }));
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [{ ...run, name: 'private-token should be masked' }],
        }),
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const service = new WorkspaceGitService(
    {} as WorkspaceCopiesService,
    { resolveForTransfer: resolve } as unknown as WorkspaceResourcesService,
  );
  const result = await service.readActions(
    'project',
    'connection',
    { operation: 'workflow_runs' },
    () => {},
  );
  expect(result).toMatchObject({ items: [{ id: runId }] });
  expect(resolve).toHaveBeenCalledWith('project', 'connection');
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'https://api.github.com/repos/owner/repo/actions/runs?per_page=50&page=1',
    expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: 'Bearer private-token',
      }) as unknown,
    }),
  );
  expect(JSON.stringify(result)).not.toContain('private-token');
});
