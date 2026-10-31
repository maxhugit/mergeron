import { beforeEach, expect, it, vi } from 'vitest';
import { observeGitHubWorkflows } from './github-workflow-observation';

const sha = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const group = 'release-refs/heads/main';
const target = { run_id: 293, run_name: 'Publish', status: 'pending' };
const blocker = {
  run_id: 292,
  run_name: 'Publish previous release',
  status: 'in_progress',
};
const run = (status = 'pending') => ({
  id: 293,
  name: 'Publish',
  head_sha: sha,
  status,
  conclusion: null,
});
const get = vi.fn<(path: string, signal: AbortSignal) => Promise<unknown>>();
const observe = () =>
  observeGitHubWorkflows(
    'example/demo',
    sha,
    <T>(path: string, signal: AbortSignal) =>
      get(path, signal).then((value) => value as T),
  );
beforeEach(() => {
  get.mockReset().mockImplementation((path) => {
    if (path.startsWith('actions/runs?'))
      return Promise.resolve({ total_count: 1, workflow_runs: [run()] });
    if (path.includes('/concurrency_groups?'))
      return Promise.resolve({
        total_count: 1,
        concurrency_groups: [
          {
            group_name: group,
            group_url: 'https://malicious.invalid/secret',
            group_members: [target],
          },
        ],
      });
    if (path.startsWith('actions/concurrency_groups/'))
      return Promise.resolve({
        group_name: group,
        total_count: 2,
        group_members: [blocker, target],
      });
    if (path.startsWith('pulls?'))
      return Promise.resolve([
        {
          number: 292,
          merged_at: '2026-10-31T10:00:00Z',
          merge_commit_sha: previous,
        },
      ]);
    if (path === 'actions/runs/292')
      return Promise.resolve({ id: 292, head_sha: previous });
    throw new Error('unexpected read');
  });
});

it('observes a pending workflow even before GitHub creates any check/job', async () => {
  const result = await observe();
  expect(result).toMatchObject({
    available: true,
    limited: false,
    items: [
      {
        id: 293,
        status: 'pending',
        waitReason: 'concurrency',
        groups: [group],
        blockers: [
          {
            id: 292,
            pullRequest: 292,
            url: 'https://github.com/example/demo/actions/runs/292',
          },
        ],
      },
    ],
  });
  expect(get.mock.calls.map(([path]) => path)).toContain(
    'actions/concurrency_groups/release-refs%2Fheads%2Fmain?ahead_of_run=293',
  );
  expect(
    get.mock.calls.every(
      ([path, signal]) =>
        !path.includes('malicious') && signal instanceof AbortSignal,
    ),
  ).toBe(true);
});

it('does not invent a PR dependency from workflow titles or branch names', async () => {
  get.mockImplementation((path) => {
    if (path.startsWith('actions/runs?'))
      return Promise.resolve({ total_count: 1, workflow_runs: [run()] });
    return Promise.reject(new Error('403 private-token'));
  });
  expect(await observe()).toEqual({
    available: true,
    limited: false,
    items: [
      {
        id: 293,
        name: 'Publish',
        status: 'pending',
        url: 'https://github.com/example/demo/actions/runs/293',
        waitReason: 'unknown',
        queueLimited: true,
      },
    ],
  });
});

it('reports optional Actions access failure without leaking credentials or a false success', async () => {
  get.mockRejectedValue(new Error('Authorization Bearer private-token'));
  expect(await observe()).toEqual({
    available: false,
    limited: false,
    items: [],
  });
});

it.each(['queued', 'waiting', 'requested', 'pending'])(
  'preserves the observed %s state when queue details are not available',
  async (status) => {
    get.mockImplementation((path) =>
      path.startsWith('actions/runs?')
        ? Promise.resolve({ total_count: 1, workflow_runs: [run(status)] })
        : Promise.resolve({ total_count: 0, concurrency_groups: [] }),
    );
    expect((await observe()).items[0]).toMatchObject({
      status,
      waitReason: 'unknown',
      blockers: [],
    });
  },
);

it('does not treat a job-level lease as the whole workflow waiting on another run', async () => {
  get.mockImplementation((path) =>
    path.startsWith('actions/runs?')
      ? Promise.resolve({ total_count: 1, workflow_runs: [run()] })
      : Promise.resolve({
          total_count: 1,
          concurrency_groups: [
            {
              group_name: group,
              group_members: [{ ...target, job_id: 41, job_name: 'build' }],
            },
          ],
        }),
  );
  expect((await observe()).items[0]).toMatchObject({
    waitReason: 'unknown',
    groups: [],
    blockers: [],
  });
  expect(get).toHaveBeenCalledTimes(2);
});

it('retains confirmed queue dependencies if PR attribution fails', async () => {
  const original = get.getMockImplementation()!;
  get.mockImplementation((path, signal) =>
    path.startsWith('pulls?')
      ? Promise.reject(new Error('denied'))
      : original(path, signal),
  );
  expect((await observe()).items[0].blockers).toEqual([
    {
      id: 292,
      name: blocker.run_name,
      status: 'in_progress',
      url: 'https://github.com/example/demo/actions/runs/292',
    },
  ]);
});

it('keeps a known concurrency group without inventing a blocker when the queue moves during observation', async () => {
  const original = get.getMockImplementation()!;
  get.mockImplementation((path, signal) =>
    path.startsWith('actions/concurrency_groups/')
      ? Promise.reject(new Error('422 run no longer in group'))
      : original(path, signal),
  );
  expect((await observe()).items[0]).toMatchObject({
    status: 'pending',
    waitReason: 'concurrency',
    groups: [group],
    blockers: [],
    queueLimited: true,
  });
});

it('marks an unexpectedly incomplete workflow response as limited', async () => {
  get.mockResolvedValue({
    total_count: 2,
    workflow_runs: [{ ...run('completed'), conclusion: 'success' }],
  });
  expect(await observe()).toMatchObject({ available: true, limited: true });
});

it.each([
  { group_name: group, total_count: 1, group_members: [blocker] },
  { group_name: 'other', total_count: 2, group_members: [blocker, target] },
  { group_name: group, total_count: 3, group_members: [blocker, target] },
])('refuses an unverified/truncated queue position: %j', async (queue) => {
  const original = get.getMockImplementation()!;
  get.mockImplementation((path, signal) =>
    path.startsWith('actions/concurrency_groups/')
      ? Promise.resolve(queue)
      : original(path, signal),
  );
  expect((await observe()).items[0]).toMatchObject({
    waitReason: 'concurrency',
    queueLimited: true,
    blockers: [],
  });
});

it('bounds workflow inspection, ignores other revisions/duplicate runs, and rejects unsafe group paths', async () => {
  get.mockImplementation((path) =>
    path.startsWith('actions/runs?')
      ? Promise.resolve({
          total_count: 30,
          workflow_runs: [
            run(),
            run(),
            { ...run(), id: 999, head_sha: previous },
          ],
        })
      : Promise.resolve({
          total_count: 1,
          concurrency_groups: [
            { group_name: '../secret', group_members: [target] },
          ],
        }),
  );
  const result = await observe();
  expect(result.limited).toBe(true);
  expect(result.items).toHaveLength(1);
  expect(result.items[0].waitReason).toBe('unknown');
  expect(get).toHaveBeenCalledTimes(2);
});

it('maps completed workflow conclusions and avoids unnecessary queue reads', async () => {
  get.mockResolvedValue({
    total_count: 1,
    workflow_runs: [{ ...run('completed'), conclusion: 'success' }],
  });
  expect((await observe()).items[0].status).toBe('success');
  expect(get).toHaveBeenCalledOnce();
});

it('bounds a large set of queued runs and marks omitted queue details', async () => {
  get.mockImplementation((path) =>
    path.startsWith('actions/runs?')
      ? Promise.resolve({
          total_count: 40,
          workflow_runs: Array.from({ length: 40 }, (_, i) => ({
            ...run(),
            id: i + 1,
          })),
        })
      : Promise.resolve({ total_count: 0, concurrency_groups: [] }),
  );
  const result = await observe();
  expect(result.items).toHaveLength(20);
  expect(result.limited).toBe(true);
  expect(get).toHaveBeenCalledTimes(3);
  expect(result.items[2].queueLimited).toBe(true);
});
