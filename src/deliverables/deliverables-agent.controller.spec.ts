import { beforeEach, expect, it, vi } from 'vitest';
import { DeliverablesController } from './deliverables.controller';

const parent = {
  id: 'parent',
  title: 'Plan',
  resourceId: 'tasks',
  parentTaskId: null,
};
const child = {
  id: 'child',
  title: 'Produce',
  resourceId: 'tasks',
  parentTaskId: 'parent',
  linkedThreadId: null,
};
let controller: DeliverablesController;
const service = {
  get: vi.fn(),
  agentWorkspace: vi.fn(),
  board: vi.fn(),
  registerAgent: vi.fn(),
  availableAgentIds: vi.fn(),
};
const threads = {
  startThread: vi.fn(),
  rememberInitialThreadCwd: vi.fn(),
  archiveThread: vi.fn(),
  setThreadName: vi.fn(),
};
const projects = {
  createTask: vi.fn(),
  createDeliverableExecutionSubtask: vi.fn(),
};
const metadata = { read: vi.fn() };
const mutations = {
  mutate: vi.fn((operation: () => Promise<unknown>) => operation()),
};
beforeEach(() => {
  vi.resetAllMocks();
  mutations.mutate.mockImplementation((operation) => operation());
  service.availableAgentIds.mockReturnValue(['existing']);
  metadata.read.mockResolvedValue({
    entries: [
      {
        archived: false,
        thread: {
          id: 'existing',
          name: 'Existing agent',
          status: { type: 'idle' },
        },
      },
    ],
  });
  service.get.mockReturnValue({
    id: 'd',
    title: 'Report',
    criteria: 'Ready',
    primaryTaskId: null,
  });
  service.agentWorkspace.mockReturnValue('/work/livrables/d');
  service.board.mockReturnValue({ tasks: [parent, child] });
  threads.startThread.mockResolvedValue({ thread: { id: 'agent' } });
  threads.archiveThread.mockResolvedValue(undefined);
  threads.setThreadName.mockResolvedValue(undefined);
  projects.createTask.mockReturnValue(child);
  controller = new DeliverablesController(
    service as never,
    {} as never,
    threads as never,
    projects as never,
    metadata as never,
    mutations as never,
  );
});
const request = {} as never;

it('lists only idle, non-archived eligible agents', async () => {
  service.availableAgentIds.mockReturnValue([
    'existing',
    'archived',
    'active',
    'unloaded',
  ]);
  metadata.read.mockResolvedValue({
    entries: [
      {
        archived: false,
        thread: {
          id: 'existing',
          name: 'Existing agent',
          status: { type: 'idle' },
        },
      },
      { archived: true, thread: { id: 'archived', status: { type: 'idle' } } },
      { archived: false, thread: { id: 'active', status: { type: 'active' } } },
      { archived: false, thread: { id: 'foreign', status: { type: 'idle' } } },
      {
        archived: false,
        thread: {
          id: 'unloaded',
          name: 'Unloaded agent',
          status: { type: 'notLoaded' },
        },
      },
    ],
  });
  expect(await controller.availableAgents('p', 'r', 'd')).toEqual({
    agents: [
      { id: 'existing', title: 'Existing agent' },
      { id: 'unloaded', title: 'Unloaded agent' },
    ],
  });
});

it('keeps the optional subtask link when assigning an existing agent', async () => {
  service.get.mockReturnValue({
    id: 'd',
    title: 'Report',
    primaryTaskId: 'parent',
  });
  await controller.agent(
    'p',
    'r',
    'd',
    { version: 1, existingThreadId: 'existing', subtaskId: 'child' },
    request,
  );
  expect(service.registerAgent).toHaveBeenCalledWith(
    'p',
    'r',
    'd',
    1,
    'existing',
    'child',
    true,
  );
  expect(threads.startThread).not.toHaveBeenCalled();
});

it('does not assign while the execution gate is busy', async () => {
  mutations.mutate.mockRejectedValue(new Error('GIT_BUSY'));
  await expect(
    controller.agent(
      'p',
      'r',
      'd',
      { version: 1, existingThreadId: 'existing' },
      request,
    ),
  ).rejects.toThrow('GIT_BUSY');
  expect(service.registerAgent).not.toHaveBeenCalled();
});

it('assigns an idle existing agent without changing its history, name or working folder', async () => {
  expect(
    await controller.agent(
      'p',
      'r',
      'd',
      { version: 1, existingThreadId: 'existing' },
      request,
    ),
  ).toEqual({ threadId: 'existing', taskId: null, createdSubtask: false });
  expect(service.registerAgent).toHaveBeenCalledWith(
    'p',
    'r',
    'd',
    1,
    'existing',
    undefined,
    true,
  );
  expect(threads.startThread).not.toHaveBeenCalled();
  expect(threads.rememberInitialThreadCwd).not.toHaveBeenCalled();
  expect(threads.setThreadName).not.toHaveBeenCalled();
  expect(mutations.mutate).toHaveBeenCalledOnce();
});

it('rejects unavailable existing agents before any task or thread is created', async () => {
  service.availableAgentIds.mockReturnValue([]);
  await expect(
    controller.agent(
      'p',
      'r',
      'd',
      { version: 1, existingThreadId: 'existing', subtaskTitle: 'New task' },
      request,
    ),
  ).rejects.toThrow('no longer available');
  expect(projects.createTask).not.toHaveBeenCalled();
  expect(service.registerAgent).not.toHaveBeenCalled();
});

it('never archives an existing agent when association fails', async () => {
  service.registerAgent.mockImplementation(() => {
    throw new Error('changed');
  });
  await expect(
    controller.agent(
      'p',
      'r',
      'd',
      { version: 1, existingThreadId: 'existing' },
      request,
    ),
  ).rejects.toThrow('changed');
  expect(threads.archiveThread).not.toHaveBeenCalled();
});

it.each([null, 'parent'])(
  'creates a direct agent without task creation even with primaryTaskId=%s',
  async (primaryTaskId) => {
    service.get.mockReturnValue({ id: 'd', title: 'Report', primaryTaskId });
    expect(
      await controller.agent('p', 'r', 'd', { version: 1 }, request),
    ).toEqual({ threadId: 'agent', taskId: null, createdSubtask: false });
    expect(service.registerAgent).toHaveBeenCalledWith(
      'p',
      'r',
      'd',
      1,
      'agent',
      undefined,
    );
    expect(projects.createTask).not.toHaveBeenCalled();
    expect(projects.createDeliverableExecutionSubtask).not.toHaveBeenCalled();
    expect(threads.startThread).toHaveBeenCalledWith({
      cwd: '/work/livrables/d',
    });
    expect(threads.setThreadName).toHaveBeenCalledWith('agent', 'Report');
  },
);

it('passes the chosen subtask while always registering the deliverable association', async () => {
  service.get.mockReturnValue({
    id: 'd',
    title: 'Report',
    primaryTaskId: 'parent',
  });
  expect(
    await controller.agent(
      'p',
      'r',
      'd',
      { version: 1, subtaskId: 'child' },
      request,
    ),
  ).toMatchObject({ taskId: 'child' });
  expect(service.registerAgent).toHaveBeenCalledWith(
    'p',
    'r',
    'd',
    1,
    'agent',
    'child',
  );
});

it('creates a subtask only when explicitly requested', async () => {
  service.get.mockReturnValue({
    id: 'd',
    title: 'Report',
    primaryTaskId: 'parent',
  });
  expect(
    await controller.agent(
      'p',
      'r',
      'd',
      { version: 1, subtaskTitle: 'Produce' },
      request,
    ),
  ).toMatchObject({ createdSubtask: true, taskId: 'child' });
  expect(projects.createTask).toHaveBeenCalledWith(
    'p',
    'tasks',
    expect.objectContaining({ parentTaskId: 'parent', title: 'Produce' }),
    expect.anything(),
  );
});

it.each([
  { subtaskId: 'missing' },
  { subtaskId: 'child' },
  { subtaskId: '' },
  { subtaskId: 'child', subtaskTitle: 'New' },
])(
  'rejects invalid subtask selections before creating a thread: %j',
  async (selection) => {
    await expect(
      controller.agent('p', 'r', 'd', { version: 1, ...selection }, request),
    ).rejects.toThrow();
    expect(threads.startThread).not.toHaveBeenCalled();
  },
);

it('archives a newly created thread if concurrent association fails', async () => {
  service.registerAgent.mockImplementation(() => {
    throw new Error('Deliverable changed');
  });
  await expect(
    controller.agent('p', 'r', 'd', { version: 1 }, request),
  ).rejects.toThrow('changed');
  expect(threads.archiveThread).toHaveBeenCalledWith('agent');
});
