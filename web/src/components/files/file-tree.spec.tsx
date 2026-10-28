/** Navigation/read failures and editor transactions; pointer geometry lives in browser tests. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FileTree } from './file-tree';
import { useFilesStore } from '@/stores/files-store';
import type { ProjectSummary } from '@/lib/projects-api';

const api = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
const projects = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ isAdministrator: true }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => session,
}));
vi.mock('@/lib/projects-api', () => ({ projectsApi: projects }));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    connected: false,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  }),
}));
vi.mock('@dnd-kit/dom', () => ({ Feedback: { configure: () => ({}) } }));
vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({ children }: { children: React.ReactNode }) => children,
  useDraggable: () => ({ ref: () => undefined, isDragging: false }),
  useDroppable: () => ({ ref: () => undefined, isDropTarget: false }),
}));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...(await original<typeof import('@/generated/api/sdk.gen')>()),
  filesReadTree: api.read,
  filesCreateDirectory: api.create,
}));

beforeEach(() => {
  session.isAdministrator = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  api.read.mockReset();
  api.create.mockReset();
  projects.mockReset();
  projects.mockImplementation(async (url: string) => {
    if (url.includes('/tree'))
      return (await api.read({ query: { root: '/work' } })).data;
    return { deliverables: [] };
  });
  useFilesStore.setState({
    rootDir: '/work',
    selectedFile: '/work/selected.ts',
  });
  api.read.mockImplementation(({ query }: { query: { root: string } }) =>
    query.root === '/work'
      ? Promise.resolve({
          data: [{ path: '/work/a', name: 'a', type: 'directory' }],
        })
      : Promise.reject(new Error('Listing denied')),
  );
});

it.each([true, false])(
  'hides only the managed system entry by default for administrator=%s',
  async (administrator) => {
    session.isAdministrator = administrator;
    api.read.mockResolvedValue({
      data: [
        { path: '/work/.mergeron', name: '.mergeron', type: 'directory' },
        { path: '/work/.git', name: '.git', type: 'directory' },
        { path: '/work/.env', name: '.env', type: 'file' },
        { path: '/work/document.docx', name: 'document.docx', type: 'file' },
      ],
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FileTree
          project={
            {
              id: 'p',
              resources: [],
              workspaces: [{ id: 'main', path: '/work', primary: true }],
            } as unknown as ProjectSummary
          }
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(
        'Mergeron internal data is hidden in this listing.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('.mergeron')).toBeNull();
    expect(screen.getByText('.git')).toBeVisible();
    expect(screen.getByText('.env')).toBeVisible();
    expect(screen.getByText('document.docx')).toBeVisible();
    if (administrator) {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Show internal data (administrator)',
        }),
      );
      expect(screen.getByText('.mergeron')).toBeVisible();
      fireEvent.click(
        screen.getByRole('button', { name: 'Hide internal data' }),
      );
      expect(screen.queryByText('.mergeron')).toBeNull();
    } else
      expect(
        screen.queryByRole('button', {
          name: 'Show internal data (administrator)',
        }),
      ).toBeNull();
    expect(useFilesStore.getState().rootDir).toBe('/work');
    expect(api.create).not.toHaveBeenCalled();
  },
);

it('does not classify a similarly named folder in an attached local directory as system data', async () => {
  api.read.mockResolvedValue({
    data: [{ path: '/work/.mergeron', name: '.mergeron', type: 'directory' }],
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileTree
        project={
          {
            id: 'p',
            resources: [],
            workspaces: [
              { id: 'main', path: '/primary', primary: true },
              { id: 'secondary', path: '/work', primary: false },
            ],
          } as unknown as ProjectSummary
        }
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('.mergeron')).toBeVisible();
  expect(
    screen.queryByText('Mergeron internal data is hidden in this listing.'),
  ).toBeNull();
});

it('shows deliverable aliases but navigates and renames using the real directory', async () => {
  projects.mockImplementation(async (url: string) => {
    if (url.includes('/tree'))
      return (
        await api.read({
          query: { root: url.includes('relativePath=a') ? '/work/a' : '/work' },
        })
      ).data;
    return { deliverables: [{ directory: '/work/a', title: 'Architecture' }] };
  });
  api.read.mockImplementation(({ query }: { query: { root: string } }) =>
    Promise.resolve({
      data:
        query.root === '/work'
          ? [{ path: '/work/a', name: 'a', type: 'directory' }]
          : [],
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileTree
        project={
          {
            id: 'p',
            resources: [{ id: 'r', type: 'deliverable_board' }],
            workspaces: [{ id: 'main', path: '/work', primary: true }],
          } as ProjectSummary
        }
      />
    </QueryClientProvider>,
  );
  const alias = await screen.findByText('Architecture');
  expect(alias).toHaveAttribute('title', '/work/a');
  fireEvent.contextMenu(alias);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  expect(
    await screen.findByRole('textbox', { name: 'File or directory name' }),
  ).toHaveValue('a');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  fireEvent.doubleClick(await screen.findByText('Architecture'));
  await waitFor(() => expect(useFilesStore.getState().rootDir).toBe('/work/a'));
  expect(await screen.findByText('Architecture')).toHaveAttribute(
    'title',
    '/work/a',
  );
});

it('recognizes a deliverable document and replaces filesystem actions with its shared menu', async () => {
  const document = {
    id: 'doc',
    deliverableId: 'd',
    name: 'report.docx',
    sourcePath: '/work/report.docx',
    format: 'docx',
    deletedAt: null,
    currentVersionNumber: 1,
    versions: [],
  };
  projects.mockImplementation(async (url: string) =>
    url.includes('/tree')
      ? [{ path: document.sourcePath, name: document.name, type: 'file' }]
      : {
          deliverables: [
            {
              id: 'd',
              directory: '/work',
              title: 'Report',
              lifecycleStatus: 'in_constitution',
              documents: [document],
            },
          ],
        },
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileTree
        project={
          {
            id: 'p',
            resources: [{ id: 'r', type: 'deliverable_board' }],
            workspaces: [{ id: 'main', path: '/work', primary: true }],
          } as ProjectSummary
        }
      />
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(await screen.findByText('report.docx'));
  expect(
    await screen.findByRole('menuitem', { name: 'History' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('menuitem', { name: 'Save a new version' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('menuitem', { name: 'Move to…' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  expect(
    await screen.findByRole('dialog', { name: 'Rename document' }),
  ).toBeInTheDocument();
});

it('rolls back directory and selection when row-menu navigation cannot list its destination', async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FileTree />
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(await screen.findByText('a'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Folder' }));
  await waitFor(() =>
    expect(api.read).toHaveBeenCalledWith(
      expect.objectContaining({ query: { root: '/work/a' } }),
    ),
  );
  await waitFor(() =>
    expect(useFilesStore.getState()).toMatchObject({
      rootDir: '/work',
      selectedFile: '/work/selected.ts',
    }),
  );
  expect(
    screen.queryByRole('textbox', { name: 'File or directory name' }),
  ).not.toBeInTheDocument();
  expect(api.create).not.toHaveBeenCalled();
});

it('creates from the empty listing background without changing the current directory', async () => {
  api.read.mockResolvedValue({ data: [] });
  api.create.mockResolvedValue({ data: { path: '/work/project', ok: true } });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FileTree />
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(await screen.findByText('Empty directory'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Folder' }));
  const input = await screen.findByRole('textbox', {
    name: 'File or directory name',
  });
  fireEvent.change(input, { target: { value: 'project' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: { path: '/work/project' } }),
    ),
  );
  expect(useFilesStore.getState().rootDir).toBe('/work');
});

/**
 * Creating does not depend on reading. When the listing itself failed, the
 * background action must still present its editor — rendering it only in the
 * success branch made the menu item silently do nothing.
 */
it('still offers the create row when the current listing cannot be read', async () => {
  api.read.mockRejectedValue(new Error('Listing denied'));
  api.create.mockResolvedValue({ data: { path: '/work/project', ok: true } });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FileTree />
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(await screen.findByText('Cannot load directories'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Folder' }));
  const input = await screen.findByRole('textbox', {
    name: 'File or directory name',
  });
  fireEvent.change(input, { target: { value: 'project' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: { path: '/work/project' } }),
    ),
  );
});
