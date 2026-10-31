/** Read-only, bounded Actions observation. No workflow/YAML evaluation or queue mutations. */
export interface ObservedWorkflowBlocker {
  id: number;
  name: string;
  status: string;
  url: string;
  jobName?: string;
  pullRequest?: number;
}
export interface ObservedWorkflow {
  id: number;
  name: string;
  status: string;
  url: string;
  waitReason?: 'concurrency' | 'unknown';
  groups?: string[];
  blockers?: ObservedWorkflowBlocker[];
  queueLimited?: boolean;
}
export interface WorkflowObservation {
  available: boolean;
  limited: boolean;
  items: ObservedWorkflow[];
}
interface Run {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}
interface Member {
  run_id: number;
  run_name: string;
  status: string;
  job_id?: number;
  job_name?: string;
}
const id = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const pending = new Set(['pending', 'queued', 'waiting', 'requested']);
const label = (value: unknown) =>
  typeof value === 'string' ? value.slice(0, 200) : '';

export async function observeGitHubWorkflows(
  repository: string,
  revision: string,
  get: <T>(endpoint: string, signal: AbortSignal) => Promise<T>,
): Promise<WorkflowObservation> {
  const signal = AbortSignal.timeout(10000);
  let remaining = 12;
  const read = <T>(endpoint: string) => {
    if (signal.aborted || remaining-- <= 0)
      return Promise.reject(new Error('Workflow observation limit'));
    return get<T>(endpoint, signal);
  };
  const runUrl = (runId: number) =>
    `https://github.com/${repository}/actions/runs/${runId}`;
  let runs: { total_count: number; workflow_runs: Run[] };
  try {
    runs = await read(`actions/runs?head_sha=${revision}&per_page=20`);
    if (!Array.isArray(runs.workflow_runs)) throw new Error('Invalid runs');
  } catch {
    return { available: false, limited: false, items: [] };
  }
  const result: WorkflowObservation = {
    available: true,
    limited:
      !Number.isSafeInteger(runs.total_count) ||
      runs.total_count < 0 ||
      runs.total_count > 20 ||
      runs.total_count !== runs.workflow_runs.length ||
      runs.workflow_runs.length > 20,
    items: [],
  };
  const seen = new Set<number>();
  for (const run of runs.workflow_runs.slice(0, 20)) {
    if (!run || !id(run.id) || run.head_sha !== revision || seen.has(run.id)) {
      result.limited = true;
      continue;
    }
    seen.add(run.id);
    result.items.push({
      id: run.id,
      name: label(run.name),
      status:
        run.status === 'completed'
          ? (run.conclusion ?? 'unknown')
          : typeof run.status === 'string'
            ? run.status
            : 'unknown',
      url: runUrl(run.id),
    });
  }

  // Inspect only two waiting runs / two groups each. Queue APIs are optional:
  // missing permissions or transient 404/422 never erase an observed pending run.
  const waiting = result.items.filter((run) => pending.has(run.status));
  for (const run of waiting) run.waitReason = 'unknown';
  for (const run of waiting.slice(0, 2)) {
    try {
      const data = await read<{
        total_count: number;
        concurrency_groups: Array<{
          group_name: string;
          group_members: Member[];
        }>;
      }>(`actions/runs/${run.id}/concurrency_groups?per_page=10`);
      if (!Array.isArray(data.concurrency_groups))
        throw new Error('Invalid groups');
      run.queueLimited =
        data.total_count > 10 || data.concurrency_groups.length > 10;
      const groups = data.concurrency_groups.filter(
        (group) =>
          typeof group.group_name === 'string' &&
          group.group_name.length > 0 &&
          group.group_name.length <= 256 &&
          !group.group_name
            .split('/')
            .some((part) => part === '.' || part === '..') &&
          !Array.from(group.group_name).some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) &&
          Array.isArray(group.group_members) &&
          group.group_members.some(
            (member) =>
              member.run_id === run.id &&
              member.job_id === undefined &&
              pending.has(member.status),
          ),
      );
      if (groups.length > 2) run.queueLimited = true;
      run.groups = groups.slice(0, 2).map((group) => group.group_name);
      if (run.groups.length) run.waitReason = 'concurrency';
      run.blockers = [];
      for (const group of run.groups) {
        try {
          const queue = await read<{
            group_name: string;
            total_count: number;
            group_members: Member[];
          }>(
            `actions/concurrency_groups/${encodeURIComponent(group)}?ahead_of_run=${run.id}`,
          );
          if (queue.group_name !== group || !Array.isArray(queue.group_members))
            throw new Error('Invalid queue');
          const members = queue.group_members;
          const current = members[members.length - 1];
          // ahead_of_run returns the target last. Never infer a blocker from
          // timestamps, a shared branch/workflow name, or unrelated job leases.
          if (
            !current ||
            current.run_id !== run.id ||
            current.job_id !== undefined ||
            !pending.has(current.status) ||
            members.length > 100 ||
            !Number.isSafeInteger(queue.total_count) ||
            queue.total_count !== members.length
          )
            throw new Error('Unverified queue position');
          const ahead = members
            .slice(0, -1)
            .filter(
              (member) =>
                id(member.run_id) &&
                member.run_id !== run.id &&
                (member.status === 'in_progress' || pending.has(member.status)),
            );
          if (ahead.length > 2) run.queueLimited = true;
          for (const member of ahead.slice(0, 2)) {
            if (run.blockers.some((blocker) => blocker.id === member.run_id))
              continue;
            run.blockers.push({
              id: member.run_id,
              name: label(member.run_name),
              status: member.status,
              url: runUrl(member.run_id),
              ...(member.job_name ? { jobName: label(member.job_name) } : {}),
            });
          }
        } catch {
          run.queueLimited = true;
        }
      }
    } catch {
      run.queueLimited = true;
    }
  }
  for (const run of waiting.slice(2)) run.queueLimited = true;

  const blockers = result.items.flatMap((run) => run.blockers ?? []);
  if (blockers.length) {
    try {
      const history = await read<
        Array<{
          number: number;
          merged_at: string | null;
          merge_commit_sha: string | null;
        }>
      >('pulls?state=closed&per_page=30&sort=updated&direction=desc');
      if (!Array.isArray(history)) throw new Error('Invalid merge history');
      const details = new Map<number, string>();
      for (const blocker of blockers.slice(0, 2)) {
        if (details.has(blocker.id)) continue;
        const detail = await read<Run>(`actions/runs/${blocker.id}`);
        if (
          detail.id === blocker.id &&
          /^[a-f0-9]{40,64}$/.test(detail.head_sha)
        )
          details.set(blocker.id, detail.head_sha);
      }
      for (const blocker of blockers) {
        const sha = details.get(blocker.id);
        const pr = history
          .slice(0, 30)
          .find(
            (pr) =>
              pr.merged_at &&
              sha &&
              pr.merge_commit_sha === sha &&
              id(pr.number),
          );
        if (pr) blocker.pullRequest = pr.number;
      }
    } catch {
      // The confirmed run dependency remains useful without a PR attribution.
    }
  }
  return result;
}
