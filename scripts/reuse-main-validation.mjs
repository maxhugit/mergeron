/** Reuse source checks only from a fresh, successful publication of this exact
 * commit on main. Images are always rebuilt, scanned and smoke-tested for tags.
 * Missing/ambiguous evidence or API errors fall back to the complete source suite.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const workflowPath = '.github/workflows/docker-publish.yml';
export const maxAgeMs = 24 * 60 * 60 * 1000;
export const requiredJobs = Object.freeze([
  'quality / checks (backend)',
  'quality / checks (frontend)',
  'quality / checks (frontend-browser, shard 1/2)',
  'quality / checks (frontend-browser, shard 2/2)',
  'quality / checks (frontend-browser)',
  'quality / quality',
  'build',
  'manager-build',
  'browser-build',
  'transcription-build / image',
  'cli-runtime',
  'promote',
  'browser-publish',
  'transcription-publish',
]);

function trustedIdentity(run, { repository, sha, workflowId }) {
  return (
    run?.repository?.full_name === repository &&
    run?.head_repository?.full_name === repository &&
    run?.head_sha === sha &&
    run?.head_branch === 'main' &&
    run?.event === 'push' &&
    run?.path === workflowPath &&
    run?.workflow_id === workflowId &&
    Number.isSafeInteger(run?.id) &&
    run.id > 0
  );
}
export function eligibleRun(run, context) {
  const completed = Date.parse(run?.updated_at);
  const started = Date.parse(run?.run_started_at);
  return (
    trustedIdentity(run, context) &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    Number.isFinite(started) &&
    Number.isFinite(completed) &&
    started <= completed &&
    completed <= context.now &&
    context.now - started <= maxAgeMs
  );
}

export async function decideReuse({
  eventName,
  ref,
  repository,
  sha,
  currentRunId,
  now = Date.now(),
  get,
}) {
  const full = (reason) => ({
    reuse: false,
    reason,
    runId: null,
    attempt: null,
  });
  if (
    eventName !== 'push' ||
    !/^refs\/tags\/v0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(ref ?? '')
  )
    return full('not_stable_tag');
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
    !/^[a-f0-9]{40}$/.test(sha ?? '')
  )
    return full('invalid_identity');
  try {
    const workflow = await get(
      `/repos/${repository}/actions/workflows/docker-publish.yml`,
    );
    if (
      !Number.isSafeInteger(workflow?.id) ||
      workflow.path !== workflowPath ||
      workflow.state !== 'active'
    )
      return full('workflow_unverified');
    const context = { repository, sha, workflowId: workflow.id, now };
    const runs = await get(
      `/repos/${repository}/actions/workflows/${workflow.id}/runs?event=push&branch=main&head_sha=${sha}&per_page=100`,
    );
    if (
      !Array.isArray(runs?.workflow_runs) ||
      runs.workflow_runs.length > 100 ||
      runs.total_count > 100
    )
      return full('ambiguous_runs');
    // Inspect the newest main invocation, not any older green run behind a
    // failed/cancelled/pending rerun. A PR result is never evidence for a tag.
    const candidates = runs.workflow_runs.filter((run) =>
      trustedIdentity(run, context),
    );
    candidates.sort((a, b) => b.id - a.id);
    const selected = candidates[0];
    if (!selected || String(selected.id) === String(currentRunId))
      return full('main_run_missing');
    const run = await get(`/repos/${repository}/actions/runs/${selected.id}`);
    if (run.id !== selected.id || !eligibleRun(run, context))
      return full('main_run_not_fresh_and_green');
    const response = await get(
      `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    );
    if (
      !Array.isArray(response?.jobs) ||
      response.total_count !== response.jobs.length ||
      response.jobs.length > 100
    )
      return full('incomplete_jobs');
    for (const name of requiredJobs) {
      const matches = response.jobs.filter((job) => job.name === name);
      if (
        matches.length !== 1 ||
        matches[0].status !== 'completed' ||
        matches[0].conclusion !== 'success'
      )
        return full('required_job_not_green');
    }
    const confirmed = await get(`/repos/${repository}/actions/runs/${run.id}`);
    if (
      !eligibleRun(confirmed, context) ||
      confirmed.id !== run.id ||
      confirmed.run_attempt !== run.run_attempt
    )
      return full('main_run_changed');
    return {
      reuse: true,
      reason: 'exact_main_commit_verified',
      runId: run.id,
      attempt: run.run_attempt,
    };
  } catch {
    // Do not log API payloads, credentials, response bodies or arbitrary errors.
    return full('evidence_unavailable');
  }
}

async function main() {
  const result = await decideReuse({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    currentRunId: process.env.GITHUB_RUN_ID,
    get: async (endpoint) => {
      const response = await fetch('https://api.github.com' + endpoint, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('API unavailable');
      const body = await response.text();
      if (body.length > 4 * 1024 ** 2) throw new Error('Response limit');
      return JSON.parse(body);
    },
  });
  const line = result.reuse
    ? `Source validation reused from main run ${result.runId}, attempt ${result.attempt}, exact commit ${process.env.GITHUB_SHA}. Image checks still run.`
    : `Full source validation required: ${result.reason}.`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `reuse=${result.reuse}\nrun_id=${result.runId ?? ''}\nattempt=${result.attempt ?? ''}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Source validation\n\n${line}\n`,
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
