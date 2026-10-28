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
import { useFilesStore } from '@/stores/files-store';
import { useLayoutStore } from '@/stores/layout-store';

const addRoot = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ isAdministrator: false }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => session,
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
  FileTree: () => (
    <div data-testid="file-tree">{useFilesStore((s) => s.rootDir)}</div>
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
      expect(screen.queryByLabelText('Active working directory') !== null).toBe(
        primaryActive,
      );
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

describe('project workspaces', () => {
  it.each([false, true])(
    'exposes the separate system space only to administrators (%s)',
    async (administrator) => {
      session.isAdministrator = administrator;
      const onActive = vi.fn();
      render(
        <WorkspaceTree
          cwd="/workspaces/main"
          project={{
            id: 'p',
            name: 'Project',
            workspacePath: '/workspaces/main',
            systemWorkspacePath: '/workspaces/.mergeron-system/main',
            resources: [],
            createdAt: 1,
            updatedAt: 1,
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
            ],
          }}
          desktop
          mobileOpen={false}
          onMobileClose={() => {}}
          onFile={() => {}}
          onActiveWorkspaceChange={onActive}
        />,
      );
      await screen.findByTestId('file-tree');
      const system = screen.queryByRole('button', { name: 'System space' });
      expect(screen.getByText('Project').parentElement).toHaveClass('h-11');
      expect(Boolean(system)).toBe(administrator);
      if (system) {
        expect(system.parentElement?.firstElementChild).toBe(system);
        fireEvent.click(system);
        expect(screen.getByTestId('system-tree')).toHaveTextContent(
          '/workspaces/.mergeron-system/main',
        );
        expect(useFilesStore.getState().rootDir).toBe('/workspaces/main');
        expect(onActive).not.toHaveBeenCalled();
      }
    },
  );
  it('lists every project workspace and keeps default selection explicit', async () => {
    const onActiveWorkspaceChange = vi.fn();
    render(
      <WorkspaceTree
        cwd="/workspaces/main"
        project={{
          id: 'project-1',
          name: 'Test',
          workspacePath: '/workspaces/main',
          createdAt: 1,
          updatedAt: 1,
          resources: [],
          workspaces: [
            {
              id: 'git-copy',
              projectId: 'project-1',
              name: 'Git Test — copie',
              path: '/workspaces/main/sources/git-copy',
              primary: false,
              sourceResourceId: 'git',
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'main',
              projectId: 'project-1',
              name: 'Principal',
              path: '/workspaces/main',
              primary: true,
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'docs',
              projectId: 'project-1',
              name: 'Documentation',
              path: '/appdata/docs',
              primary: false,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }}
        onActiveWorkspaceChange={onActiveWorkspaceChange}
        desktop
        mobileOpen={false}
        onMobileClose={() => undefined}
        onFile={() => undefined}
      />,
    );
    await screen.findByTestId('file-tree');
    expect(screen.getByText('Test')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
    expect(screen.queryByText('Git Test — copie')).toBeNull();
    expect(
      screen.getByLabelText('Active working directory'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Documentation'));
    expect(screen.getByTestId('file-tree')).toHaveTextContent('/appdata/docs');
    fireEvent.pointerDown(
      screen.getByRole('button', {
        name: 'Working folder actions · Documentation',
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Use for this conversation',
      }),
    );
    expect(onActiveWorkspaceChange).toHaveBeenCalledWith('/appdata/docs');

    const primary = screen.getByTitle('/workspaces/main');
    fireEvent.click(primary);
    expect(primary).toHaveAttribute('aria-pressed', 'true');
    expect(primary).toHaveAttribute('data-variant', 'secondary');
    fireEvent.click(screen.getByRole('button', { name: 'Git fixture' }));
    expect(screen.getByText('Git view')).toBeInTheDocument();
    expect(primary).toHaveAttribute('aria-pressed', 'false');
    expect(primary).toHaveAttribute('data-variant', 'ghost');
    expect(
      screen.getByLabelText('Active working directory'),
    ).toBeInTheDocument();
    expect(useFilesStore.getState().rootDir).toBe('/workspaces/main');
    expect(onActiveWorkspaceChange).toHaveBeenCalledTimes(1);
    fireEvent.click(primary);
    expect(primary).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('file-tree')).toHaveTextContent(
      '/workspaces/main',
    );
    expect(onActiveWorkspaceChange).toHaveBeenCalledTimes(1);
  });
});
