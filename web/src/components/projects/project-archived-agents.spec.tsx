import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import {
  ProjectArchivedAgents,
  type ArchivedAgentsProps,
} from './project-archived-agents';
import type { ProjectSummary } from '@/lib/projects-api';

export const archiveProjectFixture: ProjectSummary = {
  id: 'p',
  name: 'Project',
  workspacePath: '/project',
  workspaces: [],
  resources: [],
  createdAt: 1,
  updatedAt: 1,
  agentThreads: [
    {
      threadId: 'archive',
      title: 'Archived conversation',
      workspacePath: '/project/source',
      activeFolder: null,
      archived: true,
      archivedAt: 1793516400000,
      archivedByName: 'Original author',
      archivedByPersonId: 'author',
      archivedByType: 'person',
      taskId: 'task',
      taskResourceId: 'board',
      taskTitle: 'Design task',
      isSubtask: false,
    },
    {
      threadId: 'legacy',
      title: 'Legacy archive',
      workspacePath: '/project/source',
      activeFolder: null,
      archived: true,
      taskId: null,
      taskResourceId: null,
      taskTitle: null,
      isSubtask: false,
    },
    {
      threadId: 'active',
      title: 'Active conversation',
      workspacePath: '/project/source',
      activeFolder: null,
      archived: false,
      taskId: null,
      taskResourceId: null,
      taskTitle: null,
      isSubtask: false,
    },
  ],
};
function show(overrides: Partial<ArchivedAgentsProps> = {}) {
  const props: ArchivedAgentsProps = {
    project: archiveProjectFixture,
    pending: false,
    onOpen: vi.fn(),
    onRestore: vi.fn(),
    onFork: vi.fn(),
    onDelete: vi.fn(),
    onOpenTask: vi.fn(),
    ...overrides,
  };
  render(<ProjectArchivedAgents {...props} />);
  return props;
}
it('shows only archives, with actor snapshot, server date and honest legacy unknowns', async () => {
  const props = show();
  expect(screen.queryByText('Active conversation')).not.toBeInTheDocument();
  expect(screen.getByText('Original author')).toBeVisible();
  expect(document.querySelector('time')).toHaveAttribute(
    'dateTime',
    new Date(1793516400000).toISOString(),
  );
  expect(screen.getAllByText('Not recorded')).toHaveLength(2);
  await userEvent.click(
    screen.getByRole('button', { name: 'Archived conversation' }),
  );
  expect(props.onOpen).toHaveBeenCalledWith(
    archiveProjectFixture.agentThreads![0],
  );
  await userEvent.click(screen.getByRole('button', { name: 'Design task' }));
  expect(props.onOpenTask).toHaveBeenCalledOnce();
});
it.each(['Unarchive', 'Fork', 'Delete permanently'])(
  "offers '%s' through the actions menu",
  async (label) => {
    const props = show();
    await userEvent.click(
      screen.getByRole('button', { name: 'Actions for Archived conversation' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: label }));
    const callback =
      label === 'Unarchive'
        ? props.onRestore
        : label === 'Fork'
          ? props.onFork
          : props.onDelete;
    expect(callback).toHaveBeenCalledWith(
      archiveProjectFixture.agentThreads![0],
    );
  },
);
it('supports a right-click menu and preserves the existing deletion protection', async () => {
  const props = show({ deleteBlockedReason: 'Topology not ready' });
  fireEvent.contextMenu(
    screen.getByText('Archived conversation').closest('tr')!,
  );
  const menu = await screen.findByRole('menu');
  expect(
    within(menu).getByRole('menuitem', {
      name: 'Delete permanently',
    }),
  ).toHaveAttribute('data-disabled');
  await userEvent.click(
    within(menu).getByRole('menuitem', { name: 'Open read-only' }),
  );
  expect(props.onOpen).toHaveBeenCalledOnce();
  expect(props.onDelete).not.toHaveBeenCalled();
});
it('offers an empty state for a project with no archives', () => {
  show({ project: { ...archiveProjectFixture, agentThreads: [] } });
  expect(screen.getByText('No archived conversations')).toBeVisible();
});
