import { render, screen } from '@testing-library/react';
import { DragDropProvider } from '@dnd-kit/react';
import { expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { ThreadRow } from './thread-row';

const props: ComponentProps<typeof ThreadRow> = {
  thread: {
    id: 'agent',
    cwd: '/workspace',
    name: 'Agent',
    preview: '',
    forkedFromId: null,
    ephemeral: false,
    modelProvider: 'openai',
    model: null,
    reasoningEffort: null,
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    path: null,
    cliVersion: 'test',
    source: 'appServer',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    turns: [],
  },
  archived: false,
  isActive: false,
  destructiveDisabled: false,
  actionPending: false,
  draggable: true,
  projectId: 'project',
  onOpen: vi.fn(),
  onRename: vi.fn(),
  onArchive: vi.fn(),
  onUnarchive: vi.fn(),
  onCompact: vi.fn(),
  onFork: vi.fn(),
  onDelete: vi.fn(),
};
it('keeps the drag handle and row structure when activity changes', () => {
  const view = (running: boolean) => (
    <DragDropProvider>
      <ThreadRow {...props} running={running} destructiveDisabled={running} />
    </DragDropProvider>
  );
  const { rerender } = render(view(false));
  const handle = screen.getByRole('button', { name: 'Move conversation' });
  const open = screen.getByRole('button', { name: 'Agent' });
  expect(handle).toBeEnabled();
  rerender(view(true));
  expect(screen.getByRole('button', { name: 'Move conversation' })).toBe(
    handle,
  );
  expect(handle).toBeVisible();
  expect(handle).toBeDisabled();
  expect(open.querySelector('.animate-spin')).toBeInTheDocument();
  expect(handle.nextElementSibling).toBe(open);
  rerender(view(false));
  expect(handle).toBeEnabled();
  expect(open.querySelector('.animate-spin')).not.toBeInTheDocument();
});

it('keeps the agent icon then task icon while preserving activity indicators', () => {
  const view = (activity: Partial<ComponentProps<typeof ThreadRow>>) => (
    <DragDropProvider>
      <ThreadRow
        {...props}
        linkedTask={{ title: 'Linked subtask', isSubtask: true }}
        {...activity}
      />
    </DragDropProvider>
  );
  const { rerender } = render(view({}));
  for (const activity of [
    {},
    { running: true },
    { pendingApproval: true },
    { waitingOnUserInput: true },
  ]) {
    rerender(view(activity));
    const bot = screen
      .getByRole('button', { name: /Agent/ })
      .querySelector('.lucide-bot');
    expect(bot).toBeInTheDocument();
    expect(bot?.nextElementSibling).toHaveClass('lucide-clipboard-check');
  }
  rerender(view({ linkedTask: undefined }));
  expect(
    screen.getByRole('button', { name: 'Agent' }).querySelector('.lucide-bot'),
  ).toBeInTheDocument();
  expect(
    screen
      .getByRole('button', { name: 'Agent' })
      .querySelector('.lucide-clipboard-check'),
  ).not.toBeInTheDocument();
});
