import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  decideReuse,
  maxAgeMs,
  requiredJobs,
  workflowPath,
} from './reuse-main-validation.mjs';

function fixture() {
  const now = Date.parse('2026-11-11T10:00:00Z');
  const run = {
    id: 123,
    workflow_id: 42,
    path: workflowPath,
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    event: 'push',
    repository: { full_name: 'owner/repo' },
    head_repository: { full_name: 'owner/repo' },
    status: 'completed',
    conclusion: 'success',
    run_attempt: 2,
    run_started_at: new Date(now - 60000).toISOString(),
    updated_at: new Date(now - 1000).toISOString(),
  };
  const jobs = requiredJobs.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  }));
  const calls = [];
  const state = {
    run,
    jobs,
    workflow: { id: 42, path: workflowPath, state: 'active' },
    listed: [structuredClone(run)],
    total: jobs.length,
    confirm: null,
  };
  const options = {
    eventName: 'push',
    ref: 'refs/tags/v0.8.1',
    repository: 'owner/repo',
    sha: run.head_sha,
    currentRunId: '999',
    now,
    get: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith('workflows/docker-publish.yml'))
        return state.workflow;
      if (endpoint.includes('/workflows/42/runs?'))
        return {
          workflow_runs: state.listed,
          total_count: state.listed.length,
        };
      if (endpoint.includes('/jobs?'))
        return { jobs: state.jobs, total_count: state.total };
      const reads = calls.filter((c) => /\/actions\/runs\/\d+$/.test(c)).length;
      return reads > 1 && state.confirm ? state.confirm : state.run;
    },
  };
  return { state, options, calls };
}
test('reuses only the exact successful main publication and its specific completed attempt', async () => {
  const f = fixture();
  assert.deepEqual(await decideReuse(f.options), {
    reuse: true,
    reason: 'exact_main_commit_verified',
    runId: 123,
    attempt: 2,
  });
  assert.ok(
    f.calls.includes(
      '/repos/owner/repo/actions/runs/123/attempts/2/jobs?per_page=100',
    ),
  );
  assert.equal(
    f.calls.filter((c) => c.endsWith('/actions/runs/123')).length,
    2,
  );
});
for (const [label, modify] of [
  [
    'different SHA',
    (r) => {
      r.head_sha = 'b'.repeat(40);
    },
  ],
  [
    'different repository',
    (r) => {
      r.repository.full_name = 'other/repo';
    },
  ],
  [
    'fork',
    (r) => {
      r.head_repository.full_name = 'fork/repo';
    },
  ],
  [
    'pull request',
    (r) => {
      r.event = 'pull_request';
    },
  ],
  [
    'manual invocation',
    (r) => {
      r.event = 'workflow_dispatch';
    },
  ],
  [
    'other branch',
    (r) => {
      r.head_branch = 'release';
    },
  ],
  [
    'different workflow',
    (r) => {
      r.workflow_id = 43;
    },
  ],
  [
    'renamed workflow',
    (r) => {
      r.path = '.github/workflows/untrusted.yml';
    },
  ],
  [
    'failure',
    (r) => {
      r.conclusion = 'failure';
    },
  ],
  [
    'cancelled',
    (r) => {
      r.conclusion = 'cancelled';
    },
  ],
  [
    'pending',
    (r) => {
      r.status = 'in_progress';
    },
  ],
  [
    'unversioned attempt',
    (r) => {
      delete r.run_attempt;
    },
  ],
  [
    'invalid timestamp',
    (r) => {
      r.updated_at = 'unknown';
    },
  ],
  [
    'future completion',
    (r) => {
      r.updated_at = '2026-11-12T10:00:00Z';
    },
  ],
])
  test(`full suite for ${label}`, async () => {
    const f = fixture();
    modify(f.state.run);
    assert.equal((await decideReuse(f.options)).reuse, false);
  });
test('stale evidence is not made fresh by a recently updated result', async () => {
  const f = fixture();
  f.state.run.run_started_at = new Date(
    f.options.now - maxAgeMs - 1,
  ).toISOString();
  assert.equal((await decideReuse(f.options)).reuse, false);
});
for (const [eventName, ref] of [
  ['push', 'refs/heads/main'],
  ['workflow_dispatch', 'refs/tags/v0.8.1'],
  ['pull_request', 'refs/tags/v0.8.1'],
  ['push', 'refs/tags/v1.0.0'],
  ['push', 'refs/tags/v0.8.1-rc1'],
])
  test(`no reuse for ${eventName} ${ref}`, async () => {
    const f = fixture();
    assert.equal(
      (await decideReuse({ ...f.options, eventName, ref })).reuse,
      false,
    );
    assert.deepEqual(f.calls, []);
  });
test('a newer failed main run is not hidden by an older successful run', async () => {
  const f = fixture();
  f.state.listed.push({ ...f.state.run, id: 124, conclusion: 'failure' });
  f.state.run = { ...f.state.run, id: 124, conclusion: 'failure' };
  assert.equal((await decideReuse(f.options)).reuse, false);
  assert.ok(f.calls.includes('/repos/owner/repo/actions/runs/124'));
});
for (const conclusion of ['failure', 'cancelled', 'skipped', null])
  test(`cannot reuse a required job with conclusion ${conclusion}`, async () => {
    for (const name of requiredJobs) {
      const f = fixture();
      f.state.jobs.find((j) => j.name === name).conclusion = conclusion;
      assert.equal((await decideReuse(f.options)).reuse, false, name);
    }
  });
test('missing, duplicate and truncated jobs require the full suite', async () => {
  for (const change of [
    (s) => {
      s.jobs.pop();
      s.total = s.jobs.length;
    },
    (s) => {
      s.jobs.push({ ...s.jobs[0] });
      s.total = s.jobs.length;
    },
    (s) => {
      s.total++;
    },
    (s) => {
      s.jobs = [];
      s.total = 0;
    },
  ]) {
    const f = fixture();
    change(f.state);
    assert.equal((await decideReuse(f.options)).reuse, false);
  }
});
test('an attempt changed or restarted while reading the evidence is refused', async () => {
  for (const change of [
    (r) => ({ ...r, run_attempt: 3 }),
    (r) => ({ ...r, status: 'queued', conclusion: null }),
  ]) {
    const f = fixture();
    f.state.confirm = change(f.state.run);
    assert.equal((await decideReuse(f.options)).reuse, false);
  }
});
test('API failures are not approvals and never expose response data', async () => {
  const f = fixture();
  f.options.get = async () => {
    throw Error('private-token-do-not-log');
  };
  const result = await decideReuse(f.options);
  assert.equal(result.reuse, false);
  assert.equal(result.reason, 'evidence_unavailable');
  assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('the actual CLI emits a full-suite decision for main without needing credentials or network', () => {
  const root = mkdtempSync(join(tmpdir(), 'mergeron-source-proof-'));
  try {
    const output = join(root, 'output'),
      summary = join(root, 'summary');
    const run = spawnSync(
      process.execPath,
      ['scripts/reuse-main-validation.mjs'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_TOKEN: 'private-token-do-not-log',
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      readFileSync(output, 'utf8'),
      /^reuse=false\nrun_id=\nattempt=\n$/,
    );
    assert.ok(!run.stdout.includes('private-token'));
    assert.match(
      readFileSync(summary, 'utf8'),
      /Full source validation required/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
