import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectArchiveExportDialog } from './project-archive-transfer';
import { CreateProjectDialog } from '@/components/chat/sidebar/create-project-dialog';

const navigate = vi.fn();
const session = { isAdministrator: true };
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => session,
}));
afterEach(() => {
  vi.restoreAllMocks();
  session.isAdministrator = true;
  navigate.mockClear();
});

const createProps = {
  open: true,
  pending: false,
  name: '',
  onNameChange: vi.fn(),
  onSave: vi.fn(),
  onClose: vi.fn(),
};

function openDialog() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateProjectDialog {...createProps} />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole('tab', { name: 'Import a project from ZIP' }),
  );
}

const preview = {
  token: 'preview-token',
  projectName: 'Production project',
  sourceVersion: '0.1.0',
  targetVersion: '0.2.0',
  files: 8,
  bytes: 1024,
  warnings: [],
};

it('is available without an existing project but hidden from non-administrators', () => {
  session.isAdministrator = false;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateProjectDialog {...createProps} />
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole('tab', { name: 'Import a project from ZIP' }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText('Project name')).toBeVisible();
});

it('creates a blank project by default and offers import inside the same dialog', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateProjectDialog {...createProps} />
    </QueryClientProvider>,
  );
  expect(screen.getByLabelText('Project name')).toBeVisible();
  fireEvent.click(
    screen.getByRole('tab', { name: 'Import a project from ZIP' }),
  );
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByLabelText('Project archive')).toBeVisible();
  expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it('prevents closing or switching creation mode while inspecting the ZIP', async () => {
  let complete!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockReturnValue(
    new Promise<Response>((resolve) => {
      complete = resolve;
    }),
  );
  createProps.onClose.mockClear();
  openDialog();
  fireEvent.change(screen.getByLabelText('Project archive'), {
    target: { files: [new File(['zip'], 'project.zip')] },
  });
  expect(screen.getByRole('tab', { name: 'New project' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(createProps.onClose).not.toHaveBeenCalled();
  complete(
    new Response(JSON.stringify(preview), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await screen.findByText('Archive compatible with this installation');
  expect(screen.getByRole('tab', { name: 'New project' })).toBeEnabled();
});

it('confirms export before requesting a ZIP and shows localized network errors', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new TypeError('Failed to fetch'));
  render(
    <ProjectArchiveExportDialog
      projectId="selected-project"
      open
      onOpenChange={vi.fn()}
    />,
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Export the entire project as ZIP' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unable to download the project archive',
  );
  expect(fetch.mock.calls[0][0]).toBe(
    '/api/project-archives/selected-project/export',
  );
});

it('hides the export dialog from non-administrators', () => {
  session.isAdministrator = false;
  render(
    <ProjectArchiveExportDialog
      projectId="selected-project"
      open
      onOpenChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('requires a successful compatibility analysis before import', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(preview), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  openDialog();
  expect(
    screen.getByRole('button', { name: 'Create project from ZIP' }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Project archive'), {
    target: { files: [new File(['zip'], 'project.zip')] },
  });
  await screen.findByText('Archive compatible with this installation');
  expect(
    screen.getByText('Source Mergeron: 0.1.0 · Destination: 0.2.0'),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Create project from ZIP' }),
  ).toBeEnabled();
  expect(fetch.mock.calls[0][0]).toBe('/api/project-archives/preview');
});

it('displays the exact incompatibility reason and never enables import', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        message: 'The destination cannot read project_tasks.future_field',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  openDialog();
  fireEvent.change(screen.getByLabelText('Project archive'), {
    target: { files: [new File(['zip'], 'project.zip')] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'project_tasks.future_field',
  );
  expect(
    screen.getByRole('button', { name: 'Create project from ZIP' }),
  ).toBeDisabled();
});

it('imports only after confirmation using the opaque preview token', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/preview') ? preview : { projectId: 'copy' },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
  openDialog();
  fireEvent.change(screen.getByLabelText('Project archive'), {
    target: { files: [new File(['zip'], 'project.zip')] },
  });
  await screen.findByText('Archive compatible with this installation');
  expect(
    fetch.mock.calls.filter(([url]) => String(url).endsWith('/import')),
  ).toHaveLength(0);
  fireEvent.click(
    screen.getByRole('button', { name: 'Create project from ZIP' }),
  );
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/projects/$projectId',
      params: { projectId: 'copy' },
    }),
  );
  const call = fetch.mock.calls.find(([url]) =>
    String(url).endsWith('/import'),
  );
  expect(JSON.parse(call?.[1]?.body as string)).toEqual({
    token: 'preview-token',
    name: 'Production project (imported)',
    selection: ['files', 'conversations', 'work'],
  });
});

it('keeps macro dependencies selected and sends the chosen import categories', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/preview') ? preview : { projectId: 'copy' },
        ),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  );
  openDialog();
  fireEvent.change(screen.getByLabelText('Project archive'), {
    target: { files: [new File(['zip'], 'project.zip')] },
  });
  await screen.findByText('Archive compatible with this installation');
  const work = screen.getByRole('checkbox', {
    name: /Complete project activity/,
  });
  const conversations = screen.getByRole('checkbox', {
    name: /Agents and conversations/,
  });
  const files = screen.getByRole('checkbox', { name: /Files and folders/ });
  expect(conversations).toBeDisabled();
  expect(files).toBeDisabled();
  fireEvent.click(work);
  expect(conversations).toBeEnabled();
  fireEvent.click(conversations);
  expect(files).toBeEnabled();
  fireEvent.click(files);
  fireEvent.click(work);
  expect(conversations).toBeChecked();
  expect(files).toBeChecked();
  fireEvent.click(work);
  fireEvent.click(conversations);
  fireEvent.click(
    screen.getByRole('button', { name: 'Create project from ZIP' }),
  );
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith('/import')),
    ).toBe(true),
  );
  const call = fetch.mock.calls.find(([url]) =>
    String(url).endsWith('/import'),
  );
  expect(JSON.parse(call?.[1]?.body as string).selection).toEqual(['files']);
});
