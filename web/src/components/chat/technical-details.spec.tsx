import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentDisplayStore } from '@/stores/agent-display-store';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TimelineEntry, TurnItem } from '@/types/timeline';
import { TurnBlock } from './turn-block';

vi.mock('./turn-items/agent-message-item', () => ({
  AgentMessageItem: ({ item }: { item: { content: string } }) => (
    <p>{item.content}</p>
  ),
}));
vi.mock('./turn-items/approval-item', () => ({
  ApprovalItem: () => <button>Approve operation</button>,
}));
vi.mock('./turn-items/user-input-card', () => ({
  UserInputCard: () => <button>Answer question</button>,
}));

const initial = useTimelineStore.getState();
beforeEach(() => {
  useTimelineStore.setState({ ...initial, threadId: 'a' }, true);
  useAgentDisplayStore.setState({ byThread: {} });
});
afterEach(cleanup);

const command: TurnItem = {
  type: 'commandExecution',
  itemId: 'cmd',
  completed: true,
  command: 'echo private-details',
  content: 'technical log output',
  exitCode: 0,
};
const message: TurnItem = {
  type: 'agentMessage',
  itemId: 'message',
  completed: true,
  content: 'The full response remains unchanged, with all explanations.',
  questions: [],
};
function mount(
  items: TurnItem[] = [command, { ...command, itemId: 'cmd2' }, message],
) {
  const entry: Extract<TimelineEntry, { kind: 'turn' }> = {
    kind: 'turn',
    turnId: 'turn',
    completed: true,
    items,
  };
  return render(<TurnBlock entry={entry} />);
}

it('fully hides routine technical activity without shortening prose or deleting history', () => {
  useAgentDisplayStore.getState().record('a', 'hidden');
  mount();
  expect(screen.getByText(message.content)).toBeVisible();
  expect(screen.queryByText('technical log output')).not.toBeInTheDocument();
  expect(document.querySelectorAll('details')).toHaveLength(0);
  expect(screen.queryByText(/echo private-details/)).not.toBeInTheDocument();
  act(() => useAgentDisplayStore.getState().record('a', 'expanded'));
  expect(screen.getAllByText('technical log output')).toHaveLength(2);
  expect(screen.getAllByText(/echo private-details/)).toHaveLength(2);
});

it('shows one collapsed row per operation and switches the existing transcript immediately', () => {
  mount();
  expect(document.querySelectorAll('details')).toHaveLength(2);
  expect(screen.queryByText('technical log output')).not.toBeInTheDocument();
  act(() => useAgentDisplayStore.getState().record('a', 'expanded'));
  expect(screen.getAllByText('technical log output')).toHaveLength(2);
  act(() => useAgentDisplayStore.getState().record('a', 'hidden'));
  expect(screen.queryByText('technical log output')).not.toBeInTheDocument();
  expect(document.querySelectorAll('details')).toHaveLength(0);
  expect(screen.getByText(message.content)).toBeVisible();
  act(() => useTimelineStore.setState({ threadId: 'b' }));
  expect(document.querySelectorAll('details')).toHaveLength(2);
});

it('renders no empty bubble for completed turns containing only hidden technical activity and a diff', () => {
  useAgentDisplayStore.getState().record('a', 'hidden');
  const entry: Extract<TimelineEntry, { kind: 'turn' }> = {
    kind: 'turn',
    turnId: 'turn',
    completed: true,
    items: [command],
    diff: 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new',
  };
  const view = render(<TurnBlock entry={entry} />);
  expect(view.container).toBeEmptyDOMElement();
  act(() => useAgentDisplayStore.getState().record('a', 'collapsed'));
  expect(document.querySelectorAll('details')).toHaveLength(2);
  act(() => useAgentDisplayStore.getState().record('a', 'hidden'));
  expect(view.container).toBeEmptyDOMElement();
});

it('keeps failed commands visible even in hidden mode', () => {
  useAgentDisplayStore.getState().record('a', 'hidden');
  mount([{ ...command, exitCode: 1, content: 'Operation failed' }, message]);
  expect(screen.getByText('Operation failed')).toBeVisible();
  expect(screen.getByText(/echo private-details/)).toBeVisible();
});

it('keeps a pending authorization and its command outside collapsed details', () => {
  useAgentDisplayStore.getState().record('a', 'hidden');
  useTimelineStore.setState({
    approvals: {
      request: {
        requestId: 'request',
        kind: 'command',
        threadId: 'a',
        turnId: 'turn',
        itemId: 'cmd',
        status: 'pending',
        command: 'echo private-details',
      },
    },
  });
  mount([command]);
  expect(screen.getByText('technical log output')).toBeVisible();
  expect(document.querySelectorAll('details')).toHaveLength(0);
});

it('shows MCP failures and their error text without requiring expansion', () => {
  useAgentDisplayStore.getState().record('a', 'hidden');
  mount([
    {
      type: 'mcpToolCall',
      itemId: 'error',
      completed: true,
      failed: true,
      toolName: 'read',
      toolServer: 'files',
      toolArgs: '{}',
      content: 'Tool access failed',
    },
  ]);
  expect(screen.getByText('Tool access failed')).toBeVisible();
});

it('does not hide pending questions attached to a tool', () => {
  useAgentDisplayStore.getState().record('a', 'hidden');
  useTimelineStore.setState({
    userInputRequests: {
      request: {
        kind: 'userInput',
        requestId: 'request',
        threadId: 'a',
        turnId: 'turn',
        itemId: 'cmd',
        status: 'pending',
        questions: [],
      },
    },
  });
  mount([command]);
  expect(screen.getByRole('button', { name: 'Answer question' })).toBeVisible();
  expect(screen.getByText('technical log output')).toBeVisible();
});
