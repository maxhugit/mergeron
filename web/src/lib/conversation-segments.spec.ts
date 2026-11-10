import { beforeEach, describe, expect, it } from 'vitest';
import { useTimelineStore } from '@/stores/timeline-store';
import { projectConversationTimeline } from './conversation-segments';
import { reconcileTimeline } from './timeline-reconcile';
import { turnsToTimeline } from '@/stores/timeline-history-entries';
import type { TimelineEntry, TurnItem } from '@/types/timeline';
import type { UserInputRequest, ApprovalRequest } from '@/types/approval';
import type { TurnDto } from '@/generated/api';

const initial = useTimelineStore.getState();
const message = (content: string): TurnItem => ({
  type: 'agentMessage',
  itemId: 'answer',
  content,
  questions: [],
  completed: false,
});
const text = (rows: TimelineEntry[]) =>
  rows.flatMap((row) =>
    row.kind === 'turn'
      ? row.items.map((item) => ('content' in item ? item.content : item.type))
      : [row.kind === 'user' ? row.content : row.kind],
  );
const store = () => useTimelineStore.getState();
const timeline = () => store().threadsById.a.timeline;
const project = () => projectConversationTimeline(timeline());
const question: UserInputRequest = {
  kind: 'userInput',
  requestId: 'q',
  instanceId: 'question',
  threadId: 'a',
  turnId: 't',
  itemId: 'tool',
  status: 'pending',
  questions: [],
};

beforeEach(() => {
  useTimelineStore.setState(initial, true);
  store().selectThread('a');
  store().updateTurnItemForThread('a', 't', 'answer', () => message('Before.'));
});

describe('conversation fragments', () => {
  it('puts subsequent deltas below steering, including two interruptions of one item', () => {
    store().addSteeringMessageForThread('a', 't', 'local1', 'Adjust.', []);
    store().updateTurnItemForThread('a', 't', 'answer', () =>
      message('Before. Middle.'),
    );
    store().addSteeringMessageForThread('a', 't', 'local2', 'Again.', []);
    store().updateTurnItemForThread('a', 't', 'answer', () =>
      message('Before. Middle. After.'),
    );
    expect(text(project())).toEqual([
      'Before.',
      'Adjust.',
      ' Middle.',
      'Again.',
      ' After.',
    ]);
    expect(timeline().filter((row) => row.kind === 'turn')).toHaveLength(1);
    store().upsertUserMessageForThread('a', 't', {
      itemId: 'user1',
      text: 'Adjust.',
      images: [],
    });
    expect(text(project())).toEqual([
      'Before.',
      'Adjust.',
      ' Middle.',
      'Again.',
      ' After.',
    ]);
    expect(
      project()
        .filter((row) => row.kind === 'turn')
        .map((row) => row.presentation?.key),
    ).toEqual(['start', 'after:local1', 'after:local2']);
  });

  it('keeps continuation below a question after answer, duplicate delivery and recovery', () => {
    store().addUserInputRequestForThread('a', question);
    store().resolveUserInputRequestForThread('a', 'q');
    store().updateTurnItemForThread('a', 't', 'answer', () =>
      message('Before. After.'),
    );
    store().addUserInputRequestForThread('a', question);
    const held = timeline();
    const recovered = reconcileTimeline(
      [
        {
          kind: 'turn',
          turnId: 't',
          items: [message('Before. After.')],
          completed: false,
        },
      ],
      held,
    );
    expect(text(projectConversationTimeline(recovered))).toEqual([
      'Before.',
      'interaction',
      ' After.',
    ]);
    expect(store().userInputRequests.q.status).toBe('resolved');
  });

  it('anchors a turnless MCP question to the active response without changing the request', () => {
    store().setActiveTurnIdForThread('a', 't');
    const request: ApprovalRequest = {
      kind: 'elicitation',
      requestId: 'mcp',
      instanceId: 'mcp-instance',
      turnId: null,
      threadId: 'a',
      itemId: 'rpc',
      status: 'pending',
    };
    store().addApprovalForThread('a', request);
    store().updateTurnItemForThread('a', 't', 'answer', () =>
      message('Before. After.'),
    );
    expect(text(project())).toEqual(['Before.', 'interaction', ' After.']);
    expect(store().approvals.mcp.turnId).toBeNull();
  });

  it('never duplicates technical items across fragments', () => {
    const command: TurnItem = {
      type: 'commandExecution',
      itemId: 'cmd',
      content: 'output',
      command: 'pwd',
      completed: true,
    };
    store().updateTurnItemForThread('a', 't', 'cmd', () => command);
    store().addSteeringMessageForThread('a', 't', 'local', 'Adjust.', []);
    store().updateTurnItemForThread('a', 't', 'new', () => ({
      ...message('Next'),
      itemId: 'new',
    }));
    expect(text(project())).toEqual(['Before.', 'output', 'Adjust.', 'Next']);
    expect(
      project()
        .flatMap((row) => (row.kind === 'turn' ? row.items : []))
        .filter((item) => item.itemId === 'cmd'),
    ).toHaveLength(1);
  });

  it('retains boundaries when switching agents and rejoins text after a rejected steer', () => {
    store().addSteeringMessageForThread('a', 't', 'local', 'Adjust.', []);
    store().updateTurnItemForThread('a', 't', 'answer', () =>
      message('Before. After.'),
    );
    store().selectThread('b');
    store().selectThread('a');
    expect(text(project())).toEqual(['Before.', 'Adjust.', ' After.']);
    store().rejectSteeringMessageForThread('a', 'local');
    expect(text(project())).toEqual(['Before. After.']);
  });

  it('uses the question tool position when restoring a request alongside later items', () => {
    const tool: TurnItem = {
      type: 'commandExecution',
      itemId: 'tool',
      content: 'question tool',
      completed: true,
    };
    store().updateTurnItemForThread('a', 't', 'tool', () => tool);
    store().updateTurnItemForThread('a', 't', 'next', () => ({
      ...message('After'),
      itemId: 'next',
    }));
    store().addUserInputRequestForThread('a', question);
    expect(text(project())).toEqual([
      'Before.',
      'question tool',
      'interaction',
      'After',
    ]);
  });

  it('derives fresh history fragments from native user-item positions', () => {
    const native = {
      id: 't',
      status: 'completed',
      items: [
        {
          type: 'userMessage',
          id: 'u1',
          content: [{ type: 'text', text: 'Start' }],
        },
        { type: 'agentMessage', id: 'a1', text: 'Before' },
        {
          type: 'userMessage',
          id: 'u2',
          content: [{ type: 'text', text: 'Adjust' }],
        },
        { type: 'agentMessage', id: 'a2', text: 'After' },
      ],
    } as TurnDto;
    expect(
      text(projectConversationTimeline(turnsToTimeline([native]))),
    ).toEqual(['Start', 'Before', 'Adjust', 'After']);
  });
});
