import { beforeEach, expect, it, vi } from 'vitest';
import { DeliverablesController } from './deliverables.controller';
const service = {
  get: vi.fn(),
  agentWorkspace: vi.fn(),
  availableAgentIds: vi.fn(),
};
const metadata = { read: vi.fn() };
const mutations = { mutate: vi.fn((fn: () => Promise<unknown>) => fn()) };
const launches = { deliverable: vi.fn(), status: vi.fn() };
let controller: DeliverablesController;
beforeEach(() => {
  vi.resetAllMocks();
  mutations.mutate.mockImplementation((fn) => fn());
  service.get.mockReturnValue({ version: 3 });
  service.agentWorkspace.mockReturnValue('/work/d');
  service.availableAgentIds.mockReturnValue([
    'idle',
    'unloaded',
    'active',
    'archived',
    'elsewhere',
  ]);
  metadata.read.mockResolvedValue({
    entries: [
      {
        archived: false,
        thread: { id: 'idle', cwd: '/work/d', status: { type: 'idle' } },
      },
      {
        archived: false,
        thread: {
          id: 'unloaded',
          cwd: '/work/d',
          status: { type: 'notLoaded' },
        },
      },
      {
        archived: false,
        thread: { id: 'active', cwd: '/work/d', status: { type: 'active' } },
      },
      {
        archived: true,
        thread: { id: 'archived', cwd: '/work/d', status: { type: 'idle' } },
      },
      {
        archived: false,
        thread: { id: 'elsewhere', cwd: '/other', status: { type: 'idle' } },
      },
      {
        archived: false,
        thread: { id: 'foreign', cwd: '/work/d', status: { type: 'idle' } },
      },
    ],
  });
  controller = new DeliverablesController(
    service as never,
    {} as never,
    metadata as never,
    mutations as never,
    launches as never,
  );
});
it('offers only eligible idle and non-archived agents in the deliverable working folder', async () => {
  expect(
    (await controller.availableAgents('p', 'r', 'd')).agents.map(
      (agent) => agent.id,
    ),
  ).toEqual(['idle', 'unloaded']);
});
it('routes native creation and its optional subtask through the shared durable service', async () => {
  const body = { version: 3, requestId: 'one', subtaskTitle: 'Produce' };
  launches.deliverable.mockResolvedValue({
    id: 'receipt',
    state: 'needs_attention',
    threadId: null,
  });
  expect(await controller.agent('p', 'r', 'd', body)).toMatchObject({
    id: 'receipt',
    state: 'needs_attention',
  });
  expect(launches.deliverable).toHaveBeenCalledExactlyOnceWith(
    'p',
    'r',
    'd',
    body,
  );
  expect(mutations.mutate).not.toHaveBeenCalled();
});
it('preserves the existing-agent mutation gate while using the same durable service', async () => {
  const body = { version: 3, requestId: 'one', existingThreadId: 'idle' };
  await controller.agent('p', 'r', 'd', body);
  expect(mutations.mutate).toHaveBeenCalledOnce();
  expect(launches.deliverable).toHaveBeenCalledExactlyOnceWith(
    'p',
    'r',
    'd',
    body,
  );
});
it('delegates recovery discovery to the same project and resource scope', async () => {
  await controller.agentLaunchStatus('p', 'r', 'd');
  expect(launches.status).toHaveBeenCalledExactlyOnceWith(
    'p',
    'r',
    'deliverable',
    'd',
  );
});
