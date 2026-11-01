// Synthetic, offline comparison. Node 22.23+; no database, account or service.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';

const root = new URL('../', import.meta.url);
const baselineRef = process.argv[2];
if (!baselineRef || !/^[a-f0-9]{7,40}$/.test(baselineRef))
  throw new Error(
    'Usage: node scripts/benchmark-project-dashboard.mjs <baseline-commit-sha>',
  );
const sourcePath = 'src/projects/project-dashboard.ts';
const baselineSource = execFileSync(
  'git',
  ['show', `${baselineRef}:${sourcePath}`],
  { cwd: root, encoding: 'utf8' },
);
const currentSource = readFileSync(new URL(sourcePath, root), 'utf8');
const load = async (source) =>
  (
    await import(
      `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
    )
  ).summarizeProjects;
const baseline = await load(baselineSource);
const current = await load(currentSource);
const now = new Date(2026, 10, 1, 12).getTime();
function fixture(projectCount, tasksPerProject) {
  const projects = Array.from({ length: projectCount }, (_, index) => ({
    id: `p${index}`,
    name: `Project ${index}`,
    createdAt: now - 86400000,
    updatedAt: now,
  }));
  const resources = projects.flatMap((project) =>
    Array.from({ length: 2 }, (_, index) => ({
      id: `${project.id}-r${index}`,
      projectId: project.id,
      type: 'task_board',
      name: 'Tasks',
      config: {},
      updatedAt: now,
    })),
  );
  const statuses = resources.map((resource) => ({
    id: `${resource.id}-done`,
    resourceId: resource.id,
    kind: 'done',
  }));
  const tasks = projects.flatMap((project) =>
    Array.from({ length: tasksPerProject }, (_, index) => {
      const resourceId = `${project.id}-r${index % 2}`;
      return {
        id: `${project.id}-t${index}`,
        resourceId,
        title: `Task ${index}`,
        statusId: index % 7 === 0 ? `${resourceId}-done` : 'open',
        parentTaskId: index % 3 === 0 ? `${project.id}-t${index + 1}` : null,
        subtaskStatus: index % 11 === 0 ? 'done' : 'todo',
        executionMode: index % 2 ? 'agent' : 'manual',
        agentState:
          index % 13 === 0 ? 'error' : index % 17 === 0 ? 'review' : 'manual',
        estimateMinutes: 60,
        progress: index % 100,
        dueAt: now + ((index % 7) - 3) * 86400000,
        updatedAt: now - index,
      };
    }),
  );
  return {
    projects,
    resources,
    tasks,
    statuses,
    activity: projects.map((project) => ({
      projectId: project.id,
      updatedAt: now,
    })),
    now,
  };
}
function measure(run, input) {
  const samples = [];
  for (let index = 0; index < 10; index++) {
    const start = performance.now();
    run(input);
    if (index) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: +samples[4].toFixed(3),
    minMs: +samples[0].toFixed(3),
    maxMs: +samples.at(-1).toFixed(3),
  };
}
const cases = [];
for (const [projects, tasksPerProject] of [
  [5, 200],
  [5, 2000],
  [100, 100],
]) {
  const input = fixture(projects, tasksPerProject);
  if (!isDeepStrictEqual(baseline(input), current(input)))
    throw new Error('Dashboard output changed');
  cases.push({
    projects,
    tasks: input.tasks.length,
    equal: true,
    before: measure(baseline, input),
    after: measure(current, input),
  });
}
const stress = fixture(1, 0);
stress.activity = Array.from({ length: 150_000 }, (_, index) => ({
  projectId: 'p0',
  updatedAt: now + index,
}));
let beforeError = null;
try {
  baseline(stress);
} catch (error) {
  beforeError = error.name;
}
const activityStress = {
  events: stress.activity.length,
  beforeError,
  afterLastActivityAt: current(stress).projects[0].lastActivityAt,
  expectedLastActivityAt: now + 149_999,
};
if (
  activityStress.afterLastActivityAt !== activityStress.expectedLastActivityAt
)
  throw new Error('Large history summary is incorrect');
console.log(
  JSON.stringify(
    {
      baselineRef,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      samples: 9,
      warmups: 1,
      cases,
      activityStress,
    },
    null,
    2,
  ),
);
