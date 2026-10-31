import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DragDropProvider } from '@dnd-kit/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceOverview } from './workspace-overview';

describe('WorkspaceOverview creation menu', () => {
  it.each([true, false])(
    'offers project export only when authorized (%s)',
    async (authorized) => {
      const exportProject = vi.fn();
      const group = {
        projectId: 'selected-project',
        cwd: '/workspaces/selected-project',
        name: 'Selected project',
        threads: [],
        simpleChats: [],
      };
      render(
        <DragDropProvider>
          <WorkspaceOverview
            projectsHeader={<h2>Projects</h2>}
            workspaceGroups={[group]}
            collapsedGroups={new Set()}
            isLoading={false}
            onToggleCollapse={vi.fn()}
            onOpenProject={vi.fn()}
            onOpenArchivedDetail={vi.fn()}
            onOpenWorkspaceDetail={vi.fn()}
            onCreateAgentInWorkspace={vi.fn()}
            onCreateSimpleChatInWorkspace={vi.fn()}
            onCreateTaskBoard={vi.fn()}
            onOpenResource={vi.fn()}
            resourceActionPending={false}
            onRenameResource={vi.fn()}
            onDeleteResource={vi.fn()}
            onExportProject={authorized ? exportProject : undefined}
            renderThreadRow={() => null}
            renderSimpleChatRow={() => null}
            movingThread={false}
          />
        </DragDropProvider>,
      );
      expect(
        screen.queryByRole('button', {
          name: 'Export the entire project as ZIP',
        }),
      ).not.toBeInTheDocument();
      fireEvent.contextMenu(screen.getByText('Selected project'));
      const navigation = screen.getByRole('button', {
        name: 'Enable fast navigation for this project',
      });
      const deletion = screen.getByRole('button', { name: 'Delete project' });
      expect(navigation).toHaveClass('whitespace-nowrap');
      expect(navigation.previousElementSibling).toHaveAttribute(
        'data-slot',
        'separator',
      );
      expect(navigation.nextElementSibling).toHaveAttribute(
        'data-slot',
        'separator',
      );
      expect(navigation.nextElementSibling?.nextElementSibling).toBe(deletion);
      if (!authorized) {
        expect(
          screen.getByRole('button', { name: 'Work agent' }),
        ).toBeVisible();
        expect(
          screen.queryByRole('button', {
            name: 'Export the entire project as ZIP',
          }),
        ).not.toBeInTheDocument();
        return;
      }
      const user = userEvent.setup();
      await user.click(
        screen.getByRole('button', {
          name: 'Export the entire project as ZIP',
        }),
      );
      expect(exportProject).toHaveBeenCalledWith(group);
      expect(
        screen.queryByRole('button', {
          name: 'Export the entire project as ZIP',
        }),
      ).not.toBeInTheDocument();
    },
  );
  it.each([
    ['Automations', 'automation_board'],
    ['Deliverables management', 'deliverable_board'],
  ] as const)(
    'opens an existing %s manager instead of creating another',
    async (label, type) => {
      const open = vi.fn(),
        create = vi.fn();
      render(
        <DragDropProvider>
          <WorkspaceOverview
            projectsHeader={<h2>Projects</h2>}
            workspaceGroups={[
              {
                projectId: 'p',
                cwd: '/workspaces/p',
                threads: [],
                simpleChats: [],
                resources: [
                  {
                    id: 'existing',
                    projectId: 'p',
                    name: 'Existing manager',
                    type,
                    config: {},
                    createdAt: 1,
                    updatedAt: 1,
                  },
                ],
              },
            ]}
            collapsedGroups={new Set()}
            isLoading={false}
            onToggleCollapse={vi.fn()}
            onOpenProject={vi.fn()}
            onOpenArchivedDetail={vi.fn()}
            onOpenWorkspaceDetail={vi.fn()}
            onCreateAgentInWorkspace={vi.fn()}
            onCreateSimpleChatInWorkspace={vi.fn()}
            onCreateTaskBoard={vi.fn()}
            onCreateAutomationBoard={create}
            onCreateDeliverables={create}
            onOpenResource={open}
            resourceActionPending={false}
            onRenameResource={vi.fn()}
            onDeleteResource={vi.fn()}
            renderThreadRow={() => null}
            renderSimpleChatRow={() => null}
            movingThread={false}
          />
        </DragDropProvider>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Project actions' }));
      await user.click(screen.getByRole('button', { name: label }));
      expect(open).toHaveBeenCalledWith('p', 'existing');
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['Work agent', 'agent'],
    ['Simple conversation', 'simple'],
    ['Task manager', 'task'],
    ['Automations', 'automation'],
    ['Deliverables management', 'deliverables'],
  ] as const)('creates a %s in the selected workspace', async (label, kind) => {
    const user = userEvent.setup();
    const createAgent = vi.fn();
    const createSimpleChat = vi.fn();
    const createTaskBoard = vi.fn();
    const createAutomation = vi.fn();
    const createDeliverables = vi.fn();

    render(
      <DragDropProvider>
        <WorkspaceOverview
          projectsHeader={<h2>Projects</h2>}
          workspaceGroups={[
            { cwd: '/workspaces/ExampleProject', threads: [], simpleChats: [] },
          ]}
          collapsedGroups={new Set()}
          isLoading={false}
          onToggleCollapse={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenArchivedDetail={vi.fn()}
          onOpenWorkspaceDetail={vi.fn()}
          onCreateAgentInWorkspace={createAgent}
          onCreateSimpleChatInWorkspace={createSimpleChat}
          onCreateTaskBoard={createTaskBoard}
          onCreateAutomationBoard={createAutomation}
          onCreateDeliverables={createDeliverables}
          onOpenResource={vi.fn()}
          resourceActionPending={false}
          onRenameResource={vi.fn()}
          onDeleteResource={vi.fn()}
          renderThreadRow={() => null}
          renderSimpleChatRow={() => null}
          movingThread={false}
        />
      </DragDropProvider>,
    );

    expect(
      screen.queryByRole('button', { name: 'Archived projects' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Project actions' }));
    expect(screen.getByRole('button', { name: 'Work agent' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Simple conversation' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Task manager' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: label }));
    expect(
      kind === 'agent'
        ? createAgent
        : kind === 'simple'
          ? createSimpleChat
          : kind === 'task'
            ? createTaskBoard
            : kind === 'automation'
              ? createAutomation
              : createDeliverables,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspaces/ExampleProject' }),
    );
  });

  it('opens the project page without changing its collapsed state', async () => {
    const user = userEvent.setup();
    const openProject = vi.fn();
    const toggleCollapse = vi.fn();

    render(
      <DragDropProvider>
        <WorkspaceOverview
          projectsHeader={<h2>Projects</h2>}
          workspaceGroups={[
            {
              cwd: '/workspaces/Tests',
              projectId: 'project-1',
              name: 'Tests',
              workspaces: [0, 1].map((index) => ({
                id: `workspace-${index}`,
                projectId: 'project-1',
                name: `Workspace ${index}`,
                path: `/workspaces/Tests/${index}`,
                primary: index === 0,
                createdAt: 1,
                updatedAt: 1,
              })),
              threads: [],
              simpleChats: [],
            },
          ]}
          collapsedGroups={new Set()}
          isLoading={false}
          onToggleCollapse={toggleCollapse}
          onOpenProject={openProject}
          onOpenArchivedDetail={vi.fn()}
          onOpenWorkspaceDetail={vi.fn()}
          onCreateAgentInWorkspace={vi.fn()}
          onCreateSimpleChatInWorkspace={vi.fn()}
          onCreateTaskBoard={vi.fn()}
          onOpenResource={vi.fn()}
          resourceActionPending={false}
          onRenameResource={vi.fn()}
          onDeleteResource={vi.fn()}
          renderThreadRow={() => null}
          renderSimpleChatRow={() => null}
          movingThread={false}
        />
      </DragDropProvider>,
    );

    expect(screen.queryByText('2 local locations')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tests' }));
    expect(openProject).toHaveBeenCalledWith('project-1');
    expect(toggleCollapse).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Collapse project' }));
    expect(toggleCollapse).toHaveBeenCalledWith('/workspaces/Tests');
  });

  it('shows one compact project archive entry with its conversation count', async () => {
    const user = userEvent.setup();
    const openArchived = vi.fn();
    render(
      <DragDropProvider>
        <WorkspaceOverview
          projectsHeader={<h2>Projects</h2>}
          workspaceGroups={[
            {
              cwd: '/workspaces/Tests',
              projectId: 'project-1',
              name: 'Tests',
              threads: [],
              simpleChats: [],
              archivedAgents: [
                {
                  threadId: 'archived-1',
                  workspacePath: '/workspaces/Tests',
                  activeFolder: null,
                  title: 'First archived agent',
                  archived: true,
                  taskId: null,
                  taskResourceId: null,
                  taskTitle: null,
                  isSubtask: false,
                },
                {
                  threadId: 'archived-2',
                  workspacePath: '/workspaces/Tests',
                  activeFolder: null,
                  title: 'Second archived agent',
                  archived: true,
                  taskId: null,
                  taskResourceId: null,
                  taskTitle: null,
                  isSubtask: false,
                },
              ],
            },
          ]}
          collapsedGroups={new Set()}
          isLoading={false}
          onToggleCollapse={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenArchivedDetail={openArchived}
          onOpenWorkspaceDetail={vi.fn()}
          onCreateAgentInWorkspace={vi.fn()}
          onCreateSimpleChatInWorkspace={vi.fn()}
          onCreateTaskBoard={vi.fn()}
          onOpenResource={vi.fn()}
          resourceActionPending={false}
          onRenameResource={vi.fn()}
          onDeleteResource={vi.fn()}
          renderThreadRow={() => null}
          renderSimpleChatRow={() => null}
          movingThread={false}
        />
      </DragDropProvider>,
    );

    expect(screen.queryByText('First archived agent')).not.toBeInTheDocument();
    const archive = screen.getByRole('button', {
      name: /Archived conversations/,
    });
    expect(archive).toHaveTextContent('2');
    await user.click(archive);
    expect(openArchived).toHaveBeenCalledWith('project-1');
  });

  it('renders project items in the persisted sidebar order', () => {
    render(
      <DragDropProvider>
        <WorkspaceOverview
          projectsHeader={<h2>Projects</h2>}
          workspaceGroups={[
            {
              cwd: '/workspaces/Tests',
              projectId: 'project-1',
              name: 'Tests',
              threads: [],
              sidebarOrder: ['simple:second', 'resource:board', 'simple:first'],
              simpleChats: [
                {
                  id: 'first',
                  title: 'First chat',
                  model: 'codex',
                  projectId: 'project-1',
                  cwd: '/workspaces/Tests',
                  createdAt: 1,
                  updatedAt: 1,
                },
                {
                  id: 'second',
                  title: 'Second chat',
                  model: 'codex',
                  projectId: 'project-1',
                  cwd: '/workspaces/Tests',
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
              resources: [
                {
                  id: 'board',
                  projectId: 'project-1',
                  name: 'Board',
                  type: 'task_board',
                  config: {},
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
            },
          ]}
          collapsedGroups={new Set()}
          isLoading={false}
          onToggleCollapse={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenArchivedDetail={vi.fn()}
          onOpenWorkspaceDetail={vi.fn()}
          onCreateAgentInWorkspace={vi.fn()}
          onCreateSimpleChatInWorkspace={vi.fn()}
          onCreateTaskBoard={vi.fn()}
          onOpenResource={vi.fn()}
          resourceActionPending={false}
          onRenameResource={vi.fn()}
          onDeleteResource={vi.fn()}
          renderThreadRow={() => null}
          renderSimpleChatRow={(thread) => <span>{thread.title}</span>}
          movingThread={false}
        />
      </DragDropProvider>,
    );
    const second = screen.getByText('Second chat');
    const board = screen.getByText('Board');
    const first = screen.getByText('First chat');
    expect(
      second.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      board.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
