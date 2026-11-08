import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentContextLinks } from './agent-context-links';
import type { ProjectSummary } from '@/lib/projects-api';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('@/components/projects/project-deliverables-manager', () => ({
  ProjectDeliverablesManager: ({
    initialDeliverableId,
    modalOnly,
    onModalClose,
  }: {
    initialDeliverableId: string;
    modalOnly: boolean;
    onModalClose: () => void;
  }) =>
    modalOnly ? (
      <div role="dialog" aria-label={initialDeliverableId}>
        <button onClick={onModalClose}>Close deliverable</button>
      </div>
    ) : null,
}));
vi.mock('react-i18next', async (original) => {
  const actual = await original<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (ns?: string) =>
      ns === 'workspaces'
        ? actual.useTranslation(ns)
        : { t: globalThis.__testTranslate },
  };
});
vi.mock('@/components/projects/project-task-manager', () => ({
  ProjectTaskManager: ({
    initialTaskId,
    onModalClose,
  }: {
    initialTaskId: string;
    onModalClose: () => void;
  }) => (
    <div role="dialog" aria-label={initialTaskId}>
      <button onClick={onModalClose}>Close task</button>
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  api.mockReset();
});
const project = {
  id: 'p',
  resources: [{ id: 'board', type: 'deliverable_board' }],
  agentThreads: [
    {
      threadId: 'agent',
      taskId: 'task',
      taskResourceId: 'tasks',
      taskTitle: 'Write report',
    },
  ],
} as ProjectSummary;
function show(props: Partial<Parameters<typeof AgentContextLinks>[0]> = {}) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentContextLinks
        threadId="agent"
        project={project}
        loading={false}
        failed={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}
it('opens the linked deliverable directory without opening its modal', async () => {
  const onOpenDirectory = vi.fn();
  api.mockResolvedValue({
    tasks: [],
    deliverables: [
      {
        id: 'd',
        title: 'Design report',
        directory: '/work/livrables/design',
        conversations: [{ type: 'agent', id: 'agent' }],
      },
    ],
  });
  show({ onOpenDirectory });
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Open deliverable folder in explorer · Design report',
    }),
  );
  expect(onOpenDirectory).toHaveBeenCalledWith('/work/livrables/design');
  expect(screen.queryByRole('dialog')).toBeNull();
});

const boardData = () => ({
  tasks: [
    {
      id: 'parent',
      resourceId: 'tasks',
      title: 'Main task',
      parentTaskId: null,
      subtaskStatus: 'todo',
      progress: 0,
      linkedThreadId: null,
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `sub-${index}`,
      resourceId: 'tasks',
      parentTaskId: 'parent',
      title: `Subtask ${index}`,
      linkedThreadId: index < 3 ? 'agent' : null,
      progress: index === 0 || index === 7 ? 100 : index === 1 ? 40 : 0,
      subtaskStatus:
        index === 0 || index === 7 ? 'done' : index === 1 ? 'started' : 'todo',
    })),
  ],
  deliverables: [
    {
      id: 'report',
      title: 'Design report',
      primaryTaskId: 'parent',
      linkedAgentIds: ['agent'],
      conversations: [],
    },
  ],
});
it('opens the exact deliverable, parent or subtask without navigating away', async () => {
  api.mockResolvedValue(boardData());
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Design report' }));
  fireEvent.click(
    within(
      await screen.findByRole('dialog', { name: 'Design report' }),
    ).getByRole('button', { name: 'Design report' }),
  );
  expect(
    await screen.findByRole('dialog', { name: 'report' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText('Close deliverable'));
  const originalUrl = window.location.href;
  fireEvent.click(
    screen.getByRole('button', { name: /2 subtasks completed out of 8/ }),
  );
  fireEvent.click(await screen.findByRole('button', { name: /Subtask 1/ }));
  expect(
    await screen.findByRole('dialog', { name: 'sub-1' }),
  ).toBeInTheDocument();
  expect(window.location.href).toBe(originalUrl);
  fireEvent.click(screen.getByText('Close task'));
  fireEvent.click(
    screen.getByRole('button', { name: /2 subtasks completed out of 8/ }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Main task' }));
  expect(
    await screen.findByRole('dialog', { name: 'parent' }),
  ).toBeInTheDocument();
});
it('counts completion over the entire main task, but lists only this agent’s three subtasks', async () => {
  api.mockResolvedValue(boardData());
  show();
  const trigger = await screen.findByRole('button', {
    name: '2 subtasks completed out of 8 in the main task; 3 assigned to this agent',
  });
  fireEvent.click(trigger);
  expect(
    await screen.findByRole('button', { name: /Subtask 0/ }),
  ).toHaveTextContent('Completed');
  expect(screen.getByRole('button', { name: /Subtask 1/ })).toHaveTextContent(
    '40 %',
  );
  expect(screen.queryByRole('button', { name: /Subtask 7/ })).toBeNull();
  expect(
    screen.getByText(
      '5 other subtasks in this main task, including 1 completed.',
    ),
  ).toBeInTheDocument();
});
it('does not infer completion from 100 percent or from a cancelled state', async () => {
  const data = boardData();
  data.tasks[1].subtaskStatus = 'review';
  data.tasks[8].subtaskStatus = 'cancelled';
  api.mockResolvedValue(data);
  show();
  expect(
    await screen.findByRole('button', {
      name: /0 subtasks completed out of 8/,
    }),
  ).toBeInTheDocument();
});
it('reports legacy assignments to different main tasks instead of showing misleading totals', async () => {
  const data = boardData();
  data.tasks[2].parentTaskId = 'other-parent';
  api.mockResolvedValue(data);
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'different main tasks',
  );
  expect(
    screen.queryByRole('button', { name: /subtasks completed out of/ }),
  ).toBeNull();
});
it('also counts tasks when the project has no deliverable manager', async () => {
  api.mockResolvedValue({ tasks: boardData().tasks });
  show({
    project: {
      ...project,
      resources: [{ id: 'tasks', type: 'task_board' }],
      agentThreads: [
        { threadId: 'agent', taskId: 'sub-0', taskResourceId: 'tasks' },
      ],
    } as ProjectSummary,
  });
  expect(
    await screen.findByRole('button', {
      name: /2 subtasks completed out of 8/,
    }),
  ).toBeInTheDocument();
  expect(api).toHaveBeenCalledWith('/p/resources/tasks');
});
it('shows an empty state without fetching a board for a projectless agent', () => {
  show({ project: undefined });
  expect(screen.getByText('No linked deliverable or task')).toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});
it('does not claim no relationships while loading or on access failure', async () => {
  api.mockRejectedValue(new Error('Forbidden'));
  show({ project: { ...project, agentThreads: [] } });
  expect(
    screen.queryByText('No linked deliverable or task'),
  ).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(
    screen.queryByText('No linked deliverable or task'),
  ).not.toBeInTheDocument();
});

it('shows the server main-task progress, including work outside the current agent', async () => {
  const data = boardData();
  data.tasks[0].progress = 75;
  api.mockResolvedValue(data);
  show();
  fireEvent.click(
    await screen.findByRole('button', {
      name: /2 subtasks completed out of 8/,
    }),
  );
  expect(
    screen.getByRole('progressbar', { name: 'Progress of task Main task' }),
  ).toHaveAttribute('aria-valuenow', '75');
});
it('opens the Tasks sidebar on the exact parent without opening a second editor', async () => {
  api.mockResolvedValue(boardData());
  const event = vi.fn();
  window.addEventListener('mergeron:explorer-work', event);
  show();
  try {
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open task in sidebar · Main task',
      }),
    );
    expect(event).toHaveBeenCalledOnce();
    expect((event.mock.calls[0][0] as CustomEvent).detail).toEqual({
      threadId: 'agent',
      tab: 'tasks',
      taskId: 'parent',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  } finally {
    window.removeEventListener('mergeron:explorer-work', event);
  }
});

it('previews only active documents with their versions and the standard separate document window', async () => {
  const data = boardData();
  Object.assign(data.deliverables[0], {
    documents: [
      {
        id: 'one',
        name: 'Report.md',
        sourcePath: '/p/report.md',
        currentVersionNumber: 2,
        deletedAt: null,
      },
      {
        id: 'two',
        name: 'Deleted.md',
        sourcePath: '/p/deleted.md',
        currentVersionNumber: 1,
        deletedAt: 1,
      },
    ],
  });
  api.mockResolvedValue(data);
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Design report' }));
  const link = await screen.findByRole('link', { name: 'Report.md' });
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(link.getAttribute('href')).toContain(
    '/document?path=%2Fp%2Freport.md',
  );
  expect(screen.getByText('V2')).toBeVisible();
  expect(screen.queryByText('Deleted.md')).toBeNull();
});
