import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectDeliverablesManager } from './project-deliverables-manager';
import type { Deliverable, DeliverablesBoard } from '@/lib/deliverables-api';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/components/files/file-viewer', () => ({
  FileViewer: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="document-preview" data-read-only={readOnly} />
  ),
}));
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
vi.mock('./project-task-manager', () => ({
  ProjectTaskManager: ({
    initialTaskId,
    modalOnly,
    onModalClose,
  }: {
    initialTaskId: string;
    modalOnly: boolean;
    onModalClose: () => void;
  }) =>
    modalOnly ? (
      <div role="dialog" aria-label={initialTaskId}>
        <button onClick={onModalClose}>Close task</button>
      </div>
    ) : null,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: globalThis.__testTranslate }),
}));
const item: Deliverable = {
  id: 'd',
  title: 'Report',
  description: '',
  criteria: '',
  confidentiality: 'standard',
  authorizedGroupIds: [],
  assigneeId: null,
  dueAt: null,
  status: 'planned',
  lifecycleStatus: 'draft',
  currentSnapshotId: null,
  lastApprovedSnapshotId: null,
  validationRequired: false,
  validationStatus: 'not_required',
  finalizedAt: null,
  finalizedByPersonId: null,
  finalizedByName: null,
  primaryTaskId: null,
  taskIds: [],
  conversations: [],
  version: 3,
  validatedVersionId: null,
  activeFolder: null,
  directory: '/workspaces/p/livrables/d',
  createdAt: 1,
  updatedAt: 2,
  versions: [],
  documents: [],
  snapshots: [],
  lifecycleEvents: [],
  validations: [],
  validationEvents: [],
};
const board: DeliverablesBoard = {
  resource: {
    id: 'r',
    projectId: 'p',
    type: 'deliverable_board',
    name: 'Deliverables',
    config: {},
    createdAt: 1,
    updatedAt: 1,
  },
  deliverables: [item],
  assignees: [],
  taskManagers: [],
  personGroups: [],
  tasks: [],
  conversations: [],
};
beforeEach(() => {
  api.mockReset();
  api.mockImplementation((_path, input) => Promise.resolve(input ? {} : board));
});
afterEach(cleanup);
it('keeps modal content local and protects unsaved changes when closing', async () => {
  const slot = document.createElement('div');
  slot.id = 'deliverable-header-p-r';
  document.body.append(slot);
  const close = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectDeliverablesManager
          projectId="p"
          resourceId="r"
          initialDeliverableId="d"
          modalOnly
          onModalClose={close}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole('dialog', { name: 'Report' }),
    ).toBeInTheDocument();
    expect(slot).toBeEmptyDOMElement();
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Unsaved changes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(confirm).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    slot.remove();
    confirm.mockRestore();
  }
});
it('opens a deep-linked deliverable directly and returns to the list', async () => {
  const back = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectDeliverablesManager
        projectId="p"
        resourceId="r"
        initialDeliverableId="d"
        onBackToList={back}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByLabelText('Title')).toHaveValue('Report');
  fireEvent.click(screen.getByRole('button', { name: 'Back to deliverables' }));
  expect(back).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole('heading', { name: 'Deliverables' }),
  ).toBeInTheDocument();
});
async function setup(
  data = board,
  agentThreads: Array<{ threadId: string; title: string }> = [],
) {
  api.mockImplementation((_path, input) =>
    Promise.resolve(
      _path === undefined
        ? { projects: [{ id: 'p', agentThreads }] }
        : input
          ? {}
          : data,
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <ProjectDeliverablesManager projectId="p" resourceId="r" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Report/ }));
}
async function setupList(data = board) {
  api.mockImplementation((_path, input) => Promise.resolve(input ? {} : data));
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <ProjectDeliverablesManager projectId="p" resourceId="r" />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: /Report/ });
}

it('filters the deliverables list and resets all filters', async () => {
  await setupList({
    ...board,
    deliverables: [
      item,
      {
        ...item,
        id: 'restricted',
        title: 'Restricted architecture',
        confidentiality: 'restricted',
        authorizedGroupIds: ['group'],
        lifecycleStatus: 'finalized',
        validationRequired: true,
        validationStatus: 'approved',
        primaryTaskId: 'task',
      },
    ],
    tasks: [
      {
        id: 'task',
        title: 'Approve architecture',
        resourceId: 'tm',
        parentTaskId: null,
        status: 'Done',
        progress: 100,
        dueAt: null,
        assigneeId: null,
        assigneeName: null,
      },
    ],
  });

  fireEvent.change(screen.getByLabelText('Filter by confidentiality'), {
    target: { value: 'restricted' },
  });
  fireEvent.change(screen.getByLabelText('Filter by task association'), {
    target: { value: 'linked' },
  });
  expect(screen.queryByRole('button', { name: /Report/ })).toBeNull();
  expect(
    screen.getByRole('button', { name: /Restricted architecture/ }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Approve architecture' }));
  expect(screen.getByRole('dialog', { name: 'task' })).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'Deliverables' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(screen.getByRole('button', { name: /Report/ })).toBeInTheDocument();
});
it.each([
  {
    required: true,
    validation: 'pending' as const,
    expected: 'awaiting_validation',
  },
  {
    required: true,
    validation: 'not_required' as const,
    expected: 'awaiting_validation',
  },
  {
    required: true,
    validation: 'rejected' as const,
    expected: 'awaiting_validation',
  },
  { required: true, validation: 'approved' as const, expected: 'finalized' },
  {
    required: false,
    validation: 'not_required' as const,
    expected: 'finalized',
  },
])(
  'filters the effective lifecycle for required=$required validation=$validation',
  async ({ required, validation, expected }) => {
    await setupList({
      ...board,
      deliverables: [
        {
          ...item,
          lifecycleStatus: 'finalized',
          validationRequired: required,
          validationStatus: validation,
        },
      ],
    });
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: expected },
    });
    expect(screen.getByRole('button', { name: /Report/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: {
        value: expected === 'finalized' ? 'awaiting_validation' : 'finalized',
      },
    });
    expect(
      screen.queryByRole('button', { name: /Report/ }),
    ).not.toBeInTheDocument();
  },
);
it('keeps the table search visible and exposes filters through a mobile toggle', async () => {
  await setupList();

  expect(screen.getByRole('button', { name: /Report/ })).toHaveClass(
    'order-1',
    '@min-[36rem]:col-span-2',
  );
  expect(screen.getByTestId('deliverable-status-d')).toHaveClass(
    'order-2',
    'justify-self-end',
  );
  expect(screen.getByLabelText('Search deliverables')).toBeInTheDocument();
  const toggle = screen.getByRole('button', { name: 'Filters' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
});
it('saves the brief with its revision without a separate production status', async () => {
  await setup();
  expect(
    screen.queryByRole('combobox', { name: 'Production progress' }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Validation criteria'), {
    target: { value: 'Checked by owner' },
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Validation' }));
  expect(
    screen.queryByRole('button', { name: 'Submit deliverable for validation' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/resources/r/deliverables/d',
      expect.objectContaining({ method: 'PATCH' }),
    ),
  );
  const request = api.mock.calls.find(
    (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH',
  )?.[1] as RequestInit;
  expect(JSON.parse(request.body as string)).toMatchObject({
    criteria: 'Checked by owner',
    version: 3,
  });
});
it('submits the current document snapshot for human validation', async () => {
  await setup({
    ...board,
    deliverables: [
      {
        ...item,
        lifecycleStatus: 'finalized',
        currentSnapshotId: 'snapshot',
        validationRequired: true,
        documents: [
          {
            id: 'document',
            deliverableId: item.id,
            name: 'report.pdf',
            format: 'pdf',
            sourcePath: '/workspaces/p/report.pdf',
            currentVersionNumber: 1,
            deletedAt: null,
            createdAt: 1,
            updatedAt: 1,
            versions: [],
          },
        ],
      },
    ],
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Validation' }));
  expect(screen.getByText('Required')).toBeInTheDocument();
  expect(
    screen
      .getByRole('button', { name: 'Submit deliverable for validation' })
      .closest('footer'),
  ).not.toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit deliverable for validation' }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/resources/r/deliverables/d/validations',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  const request = api.mock.calls.find(
    (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
  )?.[1] as RequestInit;
  expect(JSON.parse(request.body as string)).toEqual({
    version: 3,
  });
});
it('creates a linked agent only through an explicit action', async () => {
  const task = {
    id: 'parent',
    title: 'Prepare report',
    resourceId: 'tm',
    parentTaskId: null,
    status: 'To do',
    progress: 0,
    dueAt: null,
    assigneeId: null,
    assigneeName: null,
    linkedThreadId: null,
  };
  await setup({
    ...board,
    taskManagers: [{ id: 'tm', name: 'Tasks' }],
    tasks: [
      task,
      { ...task, id: 'child', title: 'Review figures', parentTaskId: 'parent' },
    ],
    deliverables: [{ ...item, primaryTaskId: 'parent' }],
  });
  expect(
    api.mock.calls.some((call) => String(call[0]).endsWith('/agent')),
  ).toBe(false);
  api.mockImplementation((path, input) =>
    Promise.resolve(
      String(path).endsWith('/agent')
        ? { threadId: 'new-agent' }
        : input
          ? {}
          : board,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Entrust to an agent' }));
  expect(
    screen.getByText(/always be assigned through that subtask/i),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Create work agent' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/resources/r/deliverables/d/agent', {
      method: 'POST',
      body: JSON.stringify({
        version: 3,
        subtaskTitle: 'Produce — Report',
      }),
    }),
  );
});
it('creates an internal execution unit when no task manager is configured', async () => {
  await setup();
  api.mockImplementation((path, input) =>
    Promise.resolve(
      String(path).endsWith('/agent')
        ? { threadId: 'new-agent', taskId: 'internal-subtask' }
        : input
          ? {}
          : board,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Entrust to an agent' }));
  expect(screen.getByText(/No task manager is required/i)).toBeInTheDocument();
  expect(
    screen.getByRole('option', {
      name: 'Create an execution unit automatically',
    }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Create work agent' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/resources/r/deliverables/d/agent', {
      method: 'POST',
      body: JSON.stringify({
        version: 3,
        subtaskTitle: 'Produce — Report',
      }),
    }),
  );
});
it('changes the lifecycle only through an explicit transition action', async () => {
  await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Start constitution' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/resources/r/deliverables/d/lifecycle',
      {
        method: 'POST',
        body: JSON.stringify({ target: 'in_constitution', version: 3 }),
      },
    ),
  );
});
it('places the title and rename pencil in the shared header and save actions in the footer', async () => {
  const slot = document.createElement('div');
  slot.id = 'deliverable-header-p-r';
  document.body.appendChild(slot);
  try {
    await setup();
    await waitFor(() =>
      expect(slot).toContainElement(
        screen.getByRole('heading', { name: 'Report' }),
      ),
    );
    expect(slot).toContainElement(
      screen.getByRole('button', { name: 'Back to deliverables' }),
    );
    expect(slot).toContainElement(
      screen.getByRole('button', { name: 'Rename deliverable' }),
    );
    expect(
      screen.getByRole('button', { name: 'Save' }).closest('footer'),
    ).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Remove record' }).closest('footer'),
    ).not.toBeNull();
  } finally {
    cleanup();
    slot.remove();
  }
});
it('uses the project agent title instead of its identifier', async () => {
  await setup(
    {
      ...board,
      deliverables: [
        {
          ...item,
          conversations: [
            { id: 'agent-id', type: 'agent' },
            { id: 'agent-id', type: 'agent' },
            { id: 'legacy-id', type: 'agent' },
          ],
        },
      ],
      conversations: [{ id: 'agent-id', type: 'agent', title: 'agent-id' }],
    },
    [{ threadId: 'agent-id', title: 'Prepare the design package' }],
  );
  expect(
    await screen.findByRole('link', { name: 'Prepare the design package' }),
  ).toHaveAttribute('href', '/t/agent-id');
  expect(screen.queryByText('agent-id')).not.toBeInTheDocument();
  expect(
    screen.getAllByRole('link', { name: 'Prepare the design package' }),
  ).toHaveLength(1);
  expect(
    screen.queryByRole('link', { name: 'Open agent' }),
  ).not.toBeInTheDocument();
});
it('shows system metadata in overview instead of the header summary', async () => {
  await setup({
    ...board,
    deliverables: [{ ...item, createdByName: 'Alice', updatedByName: 'Bob' }],
  });
  expect(screen.getByText('Alice')).toBeInTheDocument();
  expect(screen.getByText('Bob')).toBeInTheDocument();
  expect(screen.getByText('System information')).toBeInTheDocument();
  expect(screen.queryByText(/documents · Updated/)).not.toBeInTheDocument();
});
it('combines lifecycle and validation requirement events in one chronological table', async () => {
  await setup({
    ...board,
    deliverables: [
      {
        ...item,
        lifecycleEvents: [
          {
            id: 'l',
            deliverableId: 'd',
            fromStatus: null,
            toStatus: 'draft',
            snapshotId: null,
            actorPersonId: null,
            actorName: 'Alice',
            createdAt: 100,
          },
        ],
        validationEvents: [
          {
            id: 'v',
            deliverableId: 'd',
            validationId: null,
            action: 'enabled',
            reason: null,
            actorPersonId: null,
            actorName: 'Bob',
            createdAt: 200,
          },
        ],
      },
    ],
  });
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(screen.getAllByRole('table')).toHaveLength(1);
  const rows = screen.getAllByRole('row');
  expect(rows[1]).toHaveTextContent('Bob');
  expect(rows[2]).toHaveTextContent('Alice');
});
it('only offers detachment for an associated main task and displays its subtasks', async () => {
  const task = {
    id: 'parent',
    title: 'Prepare report',
    resourceId: 'tm',
    parentTaskId: null,
    status: 'To do',
    progress: 0,
    dueAt: null,
    assigneeId: null,
    assigneeName: null,
  };
  await setup({
    ...board,
    taskManagers: [{ id: 'tm', name: 'Tasks' }],
    tasks: [
      task,
      { ...task, id: 'child', title: 'Review figures', parentTaskId: 'parent' },
    ],
    deliverables: [{ ...item, primaryTaskId: 'parent' }],
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Primary task' }));
  expect(
    screen.queryByRole('button', { name: 'Create task' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Associate' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Review figures' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Detach task' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/resources/r/deliverables/d', {
      method: 'PATCH',
      body: JSON.stringify({ primaryTaskId: null, version: 3 }),
    }),
  );
});
it('renames a deliverable from its header', async () => {
  await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Rename deliverable' }));
  fireEvent.change(screen.getByLabelText('Deliverable name'), {
    target: { value: 'Architecture package' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Rename$/ }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/resources/r/deliverables/d', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Architecture package', version: 3 }),
    }),
  );
});
it('keeps access controls in their dedicated tab and shows assignment summaries', async () => {
  await setup();
  expect(screen.queryByLabelText('Confidentiality')).not.toBeInTheDocument();
  expect(screen.getByText('No agent contribution')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
  expect(screen.getByLabelText('Confidentiality')).toBeInTheDocument();
  expect(
    screen.queryByRole('tab', { name: 'Tasks and conversations' }),
  ).not.toBeInTheDocument();
});
it('saves restricted access only after choosing an authorized group', async () => {
  await setup({ ...board, personGroups: [{ id: 'group', name: 'Reviewers' }] });
  fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
  fireEvent.change(screen.getByLabelText('Confidentiality'), {
    target: { value: 'restricted' },
  });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Reviewers'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/resources/r/deliverables/d',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"authorizedGroupIds":["group"]'),
      }),
    ),
  );
});
it('associates exactly one primary task', async () => {
  await setup({
    ...board,
    taskManagers: [{ id: 'tm', name: 'Tasks' }],
    tasks: [
      {
        id: 'task',
        title: 'Prepare report',
        resourceId: 'tm',
        parentTaskId: null,
        status: 'To do',
        progress: 20,
        dueAt: null,
        assigneeId: null,
        assigneeName: null,
      },
    ],
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Primary task' }));
  fireEvent.change(screen.getByLabelText('Primary task'), {
    target: { value: 'task' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Associate' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/resources/r/deliverables/d', {
      method: 'PATCH',
      body: JSON.stringify({ primaryTaskId: 'task', version: 3 }),
    }),
  );
});
it('creates an independent version from the current document file', async () => {
  const document = {
    id: 'doc',
    deliverableId: 'd',
    name: 'report.docx',
    format: 'docx',
    sourcePath: '/workspaces/p/livrables/d/report.docx',
    currentVersionNumber: 2,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 2,
    versions: [
      {
        id: 'dv2',
        documentId: 'doc',
        number: 2,
        fileName: 'report.docx',
        sourcePath: '/workspaces/p/livrables/d/report.docx',
        snapshotPath: '/history/report.docx',
        size: 42,
        sha256: 'hash',
        authorPersonId: null,
        authorName: 'Maxime',
        comment: '',
        restoredFromVersionId: null,
        createdAt: 2,
      },
    ],
  };
  await setup({
    ...board,
    deliverables: [{ ...item, documents: [document] }],
  });
  fireEvent.click(screen.getByRole('tab', { name: /Documents/ }));
  fireEvent.change(screen.getByLabelText('Version comment'), {
    target: { value: 'After review' },
  });
  expect(screen.getByRole('link', { name: 'report.docx' })).toHaveAttribute(
    'href',
    '/document?path=%2Fworkspaces%2Fp%2Flivrables%2Fd%2Freport.docx',
  );
  expect(screen.getByRole('link', { name: 'report.docx' })).toHaveAttribute(
    'target',
    '_blank',
  );
  expect(screen.getByRole('link', { name: 'report.docx' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Create a version from the current file',
    }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/resources/r/deliverables/d/documents/doc/versions',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  const request = api.mock.calls.find((call) =>
    String(call[0]).endsWith('/documents/doc/versions'),
  )?.[1] as RequestInit;
  expect(JSON.parse(request.body as string)).toEqual({
    path: '/workspaces/p/livrables/d/report.docx',
    comment: 'After review',
    expectedVersion: 2,
  });
});

it('offers Preview instead of Open and opens a read-only document sheet', async () => {
  const document = {
    id: 'doc',
    deliverableId: 'd',
    name: 'report.docx',
    format: 'docx',
    sourcePath: '/workspaces/p/livrables/d/report.docx',
    currentVersionNumber: 2,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 2,
    versions: [
      {
        id: 'dv2',
        documentId: 'doc',
        number: 2,
        fileName: 'report.docx',
        sourcePath: '/workspaces/p/livrables/d/report.docx',
        snapshotPath: '/history/report.docx',
        size: 2048,
        sha256: 'document-hash',
        authorPersonId: null,
        authorName: 'Maxime',
        comment: 'Reviewed version',
        restoredFromVersionId: null,
        createdAt: 2,
      },
    ],
  };
  await setup({
    ...board,
    deliverables: [{ ...item, documents: [document] }],
  });
  fireEvent.click(screen.getByRole('tab', { name: /Documents/ }));
  const menu = screen.getByLabelText('Actions').closest('details')!;
  menu.open = true;
  fireEvent.pointerDown(window.document.body);
  expect(menu.open).toBe(false);
  menu.open = true;
  fireEvent.keyDown(window.document, { key: 'Escape' });
  expect(menu.open).toBe(false);
  expect(screen.getByLabelText('Actions')).toHaveFocus();
  menu.open = true;
  expect(
    screen.queryByRole('button', { name: 'Open' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByTestId('document-preview')).toHaveAttribute(
    'data-read-only',
    'true',
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Versions' }));
  expect(screen.getByRole('tab', { name: 'Versions' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByRole('dialog')).toHaveTextContent('Reviewed version');
  fireEvent.click(screen.getByRole('tab', { name: 'Information' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('2.0 KB');
  expect(screen.getByRole('dialog')).toHaveTextContent('document-hash');
  expect(screen.getByRole('dialog')).toHaveTextContent(
    '/workspaces/p/livrables/d/report.docx',
  );
});

it('uploads selected files before creating their document records', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        files: [{ path: '/workspaces/p/livrables/d/brief.pdf' }],
      }),
  });
  vi.stubGlobal('fetch', fetchMock);

  await setup();
  fireEvent.click(screen.getByRole('tab', { name: /Documents/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Add a document' }));
  fireEvent.change(screen.getByLabelText('Documents'), {
    target: {
      files: [new File(['brief'], 'brief.pdf', { type: 'application/pdf' })],
    },
  });
  const addDocumentButtons = screen.getAllByRole('button', {
    name: 'Add a document',
  });
  fireEvent.click(addDocumentButtons[addDocumentButtons.length - 1]);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/p/resources/r/deliverables/d/documents',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  const request = api.mock.calls.find((call) =>
    String(call[0]).endsWith('/documents'),
  )?.[1] as RequestInit;
  expect(JSON.parse(request.body as string)).toEqual({
    path: '/workspaces/p/livrables/d/brief.pdf',
    comment: '',
  });

  vi.unstubAllGlobals();
});
