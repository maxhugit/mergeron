import { ActivityController } from './activity.controller';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { agentPreviews, projects, transcriptionJobs } from '../database/schema';
import { makeThreadFixture } from './threads.testing';
import { accessContext } from '../auth/access-context';

let database: TestDatabase;
const metadata = { read: vi.fn() };
const pending = { listPending: vi.fn() };
const releases = { installedBuild: vi.fn() };
let controller: ActivityController;
const person = {
  kind: 'person',
  personId: 'alice',
  active: true,
  role: 'standard',
} as const;
const entry = (
  id: string,
  state: 'idle' | 'active' = 'active',
  flags: string[] = [],
) => ({
  archived: false,
  thread: makeThreadFixture({
    id,
    name: id,
    status:
      state === 'active'
        ? ({ type: 'active', activeFlags: flags } as never)
        : { type: 'idle' },
  }),
});
const request = (identity: unknown = person) =>
  ({ platformIdentity: identity }) as never;
beforeEach(() => {
  database = createTestDatabase();
  metadata.read.mockResolvedValue({
    entries: [],
    freshness: { stale: false, refreshedAt: 123 },
  });
  pending.listPending.mockReturnValue([]);
  releases.installedBuild.mockResolvedValue({
    version: '0.7.5',
    channel: 'stable',
    revision: 'private-unused',
  });
  controller = new ActivityController(
    metadata as never,
    pending as never,
    releases as never,
    database.db,
  );
});
afterEach(() => {
  database.sqlite.close();
  vi.unstubAllEnvs();
});
function media(
  id: string,
  owner: string,
  state = 'transcribing',
  threadId: string | null = null,
  projectId: string | null = null,
) {
  database.db
    .insert(transcriptionJobs)
    .values({
      id,
      owner,
      filename: 'private.wav',
      sourceKey: 'secret-source-path',
      state,
      threadId,
      projectId,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}
it('counts the complete visible active set while bounding details and deduplicating waiting requests', async () => {
  metadata.read.mockResolvedValue({
    entries: [
      ...Array.from({ length: 70 }, (_, i) => entry('agent-' + i)),
      entry('idle', 'idle'),
      { ...entry('archived'), archived: true },
      entry('question', 'active', ['waitingOnUserInput']),
    ],
    freshness: { stale: false, refreshedAt: 123 },
  });
  pending.listPending.mockReturnValue([
    { threadId: 'agent-0' },
    { threadId: 'agent-0' },
    { threadId: 'idle' },
  ]);
  const result = await controller.read(request());
  expect(result.agents).toMatchObject({
    running: 69,
    waiting: 3,
    total: 72,
    stale: false,
    refreshedAt: 123,
  });
  expect(result.agents.items).toHaveLength(30);
  expect(
    result.agents.items.slice(0, 3).every((agent) => agent.state === 'waiting'),
  ).toBe(true);
});
it('filters private agents, fork ancestors, projects, jobs and impersonation owners before counting', async () => {
  database.db
    .insert(projects)
    .values([
      { id: 'p', name: 'P', workspacePath: '/p', createdAt: 1, updatedAt: 1 },
      {
        id: 'private',
        name: 'Private',
        workspacePath: '/private',
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    .run();
  database.db
    .insert(agentPreviews)
    .values(
      ['p', 'private'].map((projectId) => ({
        agentId: projectId,
        threadId: 'agent',
        projectId,
        previewId: projectId,
        runId: 'r',
        requestId: 'q',
        sourcePath: '/secret',
        profileRevision: 'r',
        state: 'starting',
        createdAt: 1,
        updatedAt: 1,
      })),
    )
    .run();
  media('mine', 'alice', 'transcribing', 'agent', 'p');
  media('other-owner', 'bob');
  media('impersonated', 'alice:imp');
  media('revoked-project', 'alice', 'queued', 'agent', 'private');
  media('revoked-thread', 'alice', 'queued', 'hidden', 'p');
  media('completed', 'alice', 'ready');
  metadata.read.mockResolvedValue({
    entries: [
      entry('agent'),
      entry('hidden'),
      {
        ...entry('fork'),
        thread: { ...entry('fork').thread, forkedFromId: 'hidden' },
      },
    ],
    freshness: { stale: false, refreshedAt: 123 },
  });
  const identities = {
    canReadProject: (_: unknown, id: string) => id === 'p',
    canReadThread: (_: unknown, id: string) => id !== 'hidden',
  };
  const result = await accessContext.run(
    { identity: person as never, identities: identities as never },
    () => controller.read(request()),
  );
  expect(result.agents.total).toBe(1);
  expect(result.operations).toEqual({
    total: 2,
    items: [
      { id: 'mine', threadId: 'agent', kind: 'media' },
      { id: 'p', threadId: 'agent', kind: 'preview' },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private.wav|secret-source-path|\/secret|private-unused/,
  );
  const impersonated = await accessContext.run(
    { identity: person as never, identities: identities as never },
    () =>
      controller.read(
        request({ ...person, impersonation: { sessionId: 'imp' } }),
      ),
  );
  expect(
    impersonated.operations.items
      .filter((item) => item.kind === 'media')
      .map((item) => item.id),
  ).toEqual(['impersonated']);
});
it('keeps independent operations available when agent metadata fails and never infers environment from channel', async () => {
  vi.stubEnv('MERGERON_STACK_ENVIRONMENT', '');
  metadata.read.mockRejectedValue(Error('offline'));
  media('mine', 'alice');
  const result = await controller.read(request());
  expect(result.agents).toMatchObject({
    total: 0,
    stale: true,
    refreshedAt: null,
  });
  expect(result.operations.total).toBe(1);
  expect(result.installation).toEqual({
    version: '0.7.5',
    channel: 'stable',
    environment: 'unknown',
  });
});
it('reports configured environment and preserves stale metadata explicitly', async () => {
  vi.stubEnv('MERGERON_STACK_ENVIRONMENT', 'development');
  metadata.read.mockResolvedValue({
    entries: [entry('agent')],
    freshness: { stale: true, refreshedAt: 123 },
  });
  const result = await controller.read(request());
  expect(result.agents.stale).toBe(true);
  expect(result.installation.environment).toBe('development');
});

it('does not recheck the entire idle history on every activity read', async () => {
  metadata.read.mockResolvedValue({
    entries: [
      ...Array.from({ length: 1000 }, (_, i) => entry('idle-' + i, 'idle')),
      entry('working'),
    ],
    freshness: { stale: false, refreshedAt: 123 },
  });
  pending.listPending.mockReturnValue([{ threadId: 'idle-4' }]);
  const canReadThread = vi.fn(
    (identity: unknown, id: string) => Boolean(identity) && id !== 'hidden',
  );
  const identities = { canReadThread };
  const result = await accessContext.run(
    { identity: person as never, identities: identities as never },
    () => controller.read(request()),
  );
  expect(result.agents).toMatchObject({ running: 1, waiting: 1, total: 2 });
  expect(canReadThread.mock.calls.map((call) => call[1])).toEqual([
    'idle-4',
    'working',
  ]);
});
