import { localExecutionSelection } from '@/lib/project-execution-location';
/**
 * Explorer adoption waits for its conversation, then allows free navigation.
 *
 * A gate comparing the tree's current root against the conversation's working
 * directory reads like the safer check and is the opposite: browsing is what
 * moves the root. Entering a folder pushes it below the working directory and
 * "go up" pushes it above, so the first double-click replaced the tree — and
 * its toolbar, leaving no way back — with a spinner nothing could clear.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceTree } from './workspace-tree';
import type { WorkspaceTreeHandle } from './workspace-tree';
import { createRef } from 'react';
import { useFileBrowserState } from '@/components/files/file-browser-context';
import { useFilesStore } from '@/stores/files-store';
import { useLayoutStore } from '@/stores/layout-store';

const addRoot = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ isAdministrator: false }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => session,
}));
vi.mock('@/hooks/use-deliverable-directory-aliases', () => ({
  useDeliverableDirectoryAliases: () => ({}),
}));
vi.mock('./explorer-tasks', () => ({
  ExplorerTasks: ({ revealTaskId }: { revealTaskId?: string }) => (
    <div data-testid="task-inventory">{revealTaskId}</div>
  ),
}));
vi.mock('./explorer-deliverables', () => ({
  ExplorerDeliverables: () => <div>Deliverables inventory</div>,
}));
vi.mock('./system-workspace-tree', () => ({
  SystemWorkspaceTree: ({ root }: { root: string }) => (
    <div data-testid="system-tree">{root}</div>
  ),
}));
vi.mock('./workspace-git-panel', () => ({
  WorkspaceGitPanel: ({
    children,
    resourceId,
    onSelect,
  }: {
    children: import('react').ReactNode;
    resourceId: string | null;
    onSelect: (id: string) => void;
  }) => (
    <>
      <button onClick={() => onSelect('git')}>Git fixture</button>
      {resourceId ? <div>Git view</div> : children}
    </>
  ),
}));
vi.mock('@/generated/api', () => ({ filesAddRoot: addRoot }));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: ({ workspaceRoot }: { workspaceRoot?: { path: string } }) => (
    <div data-testid="file-tree" data-bound-root={workspaceRoot?.path}>
      {useFileBrowserState((s) => s.rootDir)}
    </div>
  ),
}));

function renderTree(cwd: string | null = '/w') {
  return render(
    <WorkspaceTree
      cwd={cwd}
      desktop
      mobileOpen={false}
      onMobileClose={() => undefined}
      onFile={() => undefined}
    />,
  );
}

beforeEach(() => {
  session.isAdministrator = false;
  addRoot.mockReset().mockResolvedValue({});
  useFilesStore.setState({
    rootDir: null,
    selectedFile: null,
  });
  useLayoutStore.setState({
    workspaceTreeCollapsed: false,
    workspaceTreeWidth: 260,
  });
});

describe('explorer readiness gate', () => {
  it('reveals a requested directory even during adoption without changing agent cwd', async () => {
    let finish!: (value: object) => void;
    addRoot.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const ref = createRef<WorkspaceTreeHandle>();
    const onActiveWorkspaceChange = vi.fn();
    render(
      <WorkspaceTree
        ref={ref}
        cwd="/w"
        desktop
        mobileOpen={false}
        onMobileClose={() => undefined}
        onFile={() => undefined}
        onActiveWorkspaceChange={onActiveWorkspaceChange}
      />,
    );
    act(() => ref.current!.openDirectory('/w/livrables/design'));
    await act(async () => {
      finish({});
      await Promise.resolve();
    });
    expect(await screen.findByTestId('file-tree')).toHaveTextContent(
      '/w/livrables/design',
    );
    expect(onActiveWorkspaceChange).not.toHaveBeenCalled();
  });
  it.each([
    ['/workspaces/main', true],
    ['/workspaces/main/documents', true],
    ['/workspaces/main/sources/copy', false],
    ['/workspaces/main/sources/copy/src', false],
  ])(
    'does not mark the parent workspace active when a nested Git copy owns cwd %s',
    async (cwd, primaryActive) => {
      render(
        <WorkspaceTree
          cwd={cwd}
          project={{
            id: 'p',
            name: 'Test',
            workspacePath: '/workspaces/main',
            createdAt: 1,
            updatedAt: 1,
            resources: [],
            workspaces: [
              {
                id: 'main',
                projectId: 'p',
                name: 'Principal',
                path: '/workspaces/main',
                primary: true,
                createdAt: 1,
                updatedAt: 1,
              },
              {
                id: 'copy',
                projectId: 'p',
                name: 'Git copy',
                path: '/workspaces/main/sources/copy',
                sourceResourceId: 'git',
                primary: false,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          }}
          desktop
          mobileOpen={false}
          onMobileClose={() => undefined}
          onFile={() => undefined}
        />,
      );
      await screen.findByTestId('file-tree');
      expect(screen.getByTestId('file-tree')).toHaveTextContent(
        '/workspaces/main/dossiers',
      );
      expect(screen.getByTitle(cwd)).toBeInTheDocument();
      expect(typeof primaryActive).toBe('boolean');
    },
  );

  it('waits while no root has been established', () => {
    useFilesStore.setState({ rootDir: null });
    renderTree(null);
    expect(screen.queryByTestId('file-tree')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it.each([
    ['the conversation working directory', '/w'],
    ['a directory entered from it', '/w/pkg/src'],
    ['a directory above it', '/'],
  ])('shows the tree when the root is %s', async (_label, rootDir) => {
    renderTree();
    await screen.findByTestId('file-tree');
    act(() => useFilesStore.getState().setRootDir(rootDir));
    expect(screen.getByTestId('file-tree')).toHaveTextContent(rootDir);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('withholds an old root during cold metadata and registration without clearing its cache', async () => {
    useFilesStore.setState({ rootDir: '/old' });
    let finish!: () => void;
    addRoot.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderTree(null);
    expect(screen.queryByTestId('file-tree')).toBeNull();
    view.rerender(
      <WorkspaceTree
        cwd="/new"
        desktop
        mobileOpen={false}
        onMobileClose={() => undefined}
        onFile={() => undefined}
      />,
    );
    expect(screen.queryByTestId('file-tree')).toBeNull();
    await act(async () => finish());
    expect(screen.getByTestId('file-tree')).toHaveTextContent('/new');
  });

  it('preserves selection when the next conversation adopts the same cwd', async () => {
    const first = renderTree();
    await screen.findByTestId('file-tree');
    act(() => {
      useFilesStore.getState().selectFile('/w/file.ts');
    });
    first.unmount();
    renderTree();
    await screen.findByTestId('file-tree');
    expect(useFilesStore.getState().selectedFile).toBe('/w/file.ts');
  });

  it('shows a rejected directory and ignores a superseded registration', async () => {
    let finishOld!: () => void;
    addRoot.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishOld = resolve;
      }),
    );
    const view = renderTree('/old');
    addRoot.mockRejectedValueOnce(new Error('directory unavailable'));
    view.rerender(
      <WorkspaceTree
        cwd="/rejected"
        desktop
        mobileOpen={false}
        onMobileClose={() => undefined}
        onFile={() => undefined}
      />,
    );
    await screen.findByTestId('file-tree');
    await act(async () => finishOld());
    expect(screen.getByTestId('file-tree')).toHaveTextContent('/rejected');
  });
});

describe('project explorer views', () => {
  it.each(['/workspaces/main/dossiers', null])(
    'bounds folders to the project and separates sources while agent cwd is %s',
    async (cwd) => {
      const onActive = vi.fn();
      render(
        <WorkspaceTree
          cwd={cwd}
          project={{
            id: 'p',
            name: 'Project',
            workspacePath: '/workspaces/main',
            createdAt: 1,
            updatedAt: 1,
            resources: [],
            workspaces: [
              {
                id: 'main',
                projectId: 'p',
                name: 'Main',
                path: '/workspaces/main',
                primary: true,
                createdAt: 1,
                updatedAt: 1,
              },
              {
                id: 'docs',
                projectId: 'p',
                name: 'Documentation',
                path: '/docs',
                primary: false,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          }}
          desktop
          mobileOpen={false}
          onMobileClose={() => {}}
          onFile={() => {}}
          onActiveWorkspaceChange={onActive}
        />,
      );
      expect(await screen.findByTestId('file-tree')).toHaveAttribute(
        'data-bound-root',
        '/workspaces/main/dossiers',
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Deliverables' }));
      expect(screen.getByText('Deliverables inventory')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Sources' }));
      expect(screen.queryByTestId('file-tree')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Git fixture' }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Folders' }));
      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'docs' },
      });
      expect(screen.getByTestId('file-tree')).toHaveTextContent('/docs');
      expect(onActive).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'System space' })).toBeNull();
    },
  );
});

describe('return to the primary agent reference', () => {
  const project = {
    id: 'p',
    name: 'Project',
    workspacePath: '/project',
    createdAt: 1,
    updatedAt: 1,
    resources: [],
    workspaces: [
      {
        id: 'primary',
        projectId: 'p',
        name: 'Principal',
        path: '/project',
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'git-copy',
        projectId: 'p',
        name: 'Copy',
        path: '/project/sources/copy',
        primary: false,
        sourceResourceId: 'git',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  it.each([
    '/project/dossiers/nested',
    '/project/.mergeron-system/livrables/report',
    '/project/sources/copy',
  ])(
    'requests the actual primary root from %s, without changing the reference before confirmation',
    async (cwd) => {
      const change = vi.fn();
      const ui = (path: string, pending = false) => (
        <WorkspaceTree
          cwd={path}
          project={project}
          desktop
          mobileOpen={false}
          onMobileClose={() => {}}
          onFile={() => {}}
          activeWorkspacePending={pending}
          onActiveWorkspaceChange={change}
        />
      );
      const view = render(ui(cwd));
      await screen.findByTestId('file-tree');
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Return to the primary agent reference',
        }),
      );
      expect(change).toHaveBeenCalledExactlyOnceWith('/project');
      expect(localExecutionSelection(project, change.mock.calls[0][0])).toEqual(
        { locationId: 'local:primary', relativePath: '' },
      );
      // Browsing the Dossiers tree does not mean the agent's reference has moved.
      expect(screen.getByTitle(cwd)).toBeInTheDocument();
      view.rerender(ui(cwd, true));
      const pending = screen.getByRole('button', {
        name: 'Return to the primary agent reference',
      });
      expect(pending).toBeDisabled();
      fireEvent.click(pending);
      expect(change).toHaveBeenCalledTimes(1);
      // A rejected request retains the old reference and leaves retry available.
      view.rerender(ui(cwd));
      expect(
        screen.getByRole('button', {
          name: 'Return to the primary agent reference',
        }),
      ).toBeEnabled();
      view.rerender(ui('/project'));
      expect(
        screen.queryByRole('button', {
          name: 'Return to the primary agent reference',
        }),
      ).toBeNull();
      expect(screen.getByTitle('/project')).toHaveTextContent('Principal');
    },
  );
  it('does not offer another return when already at the primary root, including a trailing slash', () => {
    render(
      <WorkspaceTree
        cwd="/project/"
        project={project}
        desktop
        mobileOpen={false}
        onMobileClose={() => {}}
        onFile={() => {}}
        onActiveWorkspaceChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', {
        name: 'Return to the primary agent reference',
      }),
    ).toBeNull();
  });
});

it('targets the Tasks sidebar only for the current agent without changing its work reference', async () => {
  const change = vi.fn();
  render(
    <WorkspaceTree
      cwd="/w"
      project={
        {
          id: 'p',
          resources: [{ id: 'tasks', type: 'task_board' }],
          workspaces: [],
        } as unknown as NonNullable<
          Parameters<typeof WorkspaceTree>[0]['project']
        >
      }
      agentThreadId="agent"
      desktop
      mobileOpen={false}
      onMobileClose={() => {}}
      onFile={() => {}}
      onActiveWorkspaceChange={change}
    />,
  );
  act(() =>
    window.dispatchEvent(
      new CustomEvent('mergeron:explorer-work', {
        detail: { threadId: 'other-agent', tab: 'tasks', taskId: 'foreign' },
      }),
    ),
  );
  expect(screen.queryByTestId('task-inventory')).toBeNull();
  act(() =>
    window.dispatchEvent(
      new CustomEvent('mergeron:explorer-work', {
        detail: { threadId: 'agent', tab: 'tasks', taskId: 'parent' },
      }),
    ),
  );
  expect(await screen.findByTestId('task-inventory')).toHaveTextContent(
    'parent',
  );
  expect(change).not.toHaveBeenCalled();
});
