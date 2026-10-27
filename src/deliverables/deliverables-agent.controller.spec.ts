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
beforeEach(() => {
  vi.resetAllMocks();
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
  );
});
const request = {} as never;

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
