import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentMessageItem } from './agent-message-item';
import { UserInputCard } from './user-input-card';
import { useTimelineStore } from '@/stores/timeline-store';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
import type { UserInputRequest } from '@/types/approval';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-request-response', () => ({
  useRequestResponse: () => ({ send, submitting: false }),
}));
vi.mock('../markdown-renderer', () => ({ MarkdownRenderer: () => null }));
const initial = useTimelineStore.getState();
beforeEach(() => {
  send.mockReset();
  useTimelineStore.setState({ ...initial, threadId: 'selected' }, true);
  useComposerDraftStore.setState({ drafts: {}, forgotten: new Set() });
});

it('keeps asynchronous choices usable after the message completes and preserves existing drafts', () => {
  vi.useFakeTimers();
  try {
    useComposerDraftStore.getState().setText('selected', 'My existing draft');
    const item = {
      type: 'agentMessage' as const,
      itemId: 'question',
      content: '',
      completed: false,
      questions: [
        { title: 'Which installation?', options: ['Manager', 'More details'] },
      ],
    };
    const view = render(<AgentMessageItem item={item} />);
    view.rerender(<AgentMessageItem item={{ ...item, completed: true }} />);
    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    fireEvent.click(screen.getByRole('button', { name: 'Manager' }));
    expect(useComposerDraftStore.getState().drafts.selected.text).toBe(
      'My existing draft\n\nWhich installation?\nManager',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manager' }));
    expect(
      useComposerDraftStore
        .getState()
        .drafts.selected.text.match(/Which installation/g),
    ).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('lets a retired question prepare a normal reply in its own conversation without answering an expired RPC', () => {
  const request: UserInputRequest = {
    kind: 'userInput',
    requestId: 1,
    threadId: 'owner',
    turnId: 'turn',
    itemId: 'item',
    status: 'pending',
    questions: [
      {
        id: 'q',
        header: 'Installation',
        question: 'Use the manager?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Yes', description: 'Use the manager' },
          { label: 'No', description: '' },
        ],
      },
    ],
  };
  const view = render(<UserInputCard request={request} />);
  fireEvent.click(screen.getByRole('radio', { name: /Yes/ }));
  view.rerender(<UserInputCard request={{ ...request, status: 'resolved' }} />);
  expect(screen.getByRole('radio', { name: /Yes/ })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare a reply' }));
  expect(useComposerDraftStore.getState().drafts.owner.text).toBe(
    'Use the manager?\nYes',
  );
  expect(useComposerDraftStore.getState().drafts.selected).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});

it('keeps the normal pending request submission contract', () => {
  const request: UserInputRequest = {
    kind: 'userInput',
    requestId: 1,
    threadId: 'owner',
    turnId: 'turn',
    itemId: 'item',
    status: 'pending',
    questions: [
      {
        id: 'q',
        header: 'Choice',
        question: 'Which?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Yes', description: '' }],
      },
    ],
  };
  render(<UserInputCard request={request} />);
  fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(send).toHaveBeenCalledWith({ answers: { q: { answers: ['Yes'] } } });
  expect(useComposerDraftStore.getState().drafts).toEqual({});
});

it('never copies a retired secret question into a normal conversation message', () => {
  const request: UserInputRequest = {
    kind: 'userInput',
    requestId: 1,
    threadId: 'owner',
    turnId: 'turn',
    itemId: 'item',
    status: 'resolved',
    questions: [
      {
        id: 'q',
        header: 'Secret',
        question: 'Password?',
        isOther: false,
        isSecret: true,
        options: null,
      },
    ],
  };
  render(<UserInputCard request={request} />);
  expect(
    screen.queryByRole('button', { name: 'Prepare a reply' }),
  ).not.toBeInTheDocument();
  expect(useComposerDraftStore.getState().drafts).toEqual({});
});
