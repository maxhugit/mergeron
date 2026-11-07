import { beforeEach, expect, it, vi } from 'vitest';
import { useTimelineStore } from '@/stores/timeline-store';
import {
  beginSteerSubmission,
  rejectSteerSubmission,
} from './steer-submission';
import { turnsToTimeline } from '@/stores/timeline-history-entries';
import { reconcileTimeline } from './timeline-reconcile';
import {
  handleItemStarted,
  handleItemCompleted,
} from '@/hooks/notification-item-handlers';
import type { NotificationContext } from '@/hooks/notification-context';
import type { TurnDto } from '@/generated/api';

vi.mock('@/socket', () => ({
  getSocket: () => ({ emit: vi.fn(), connected: false }),
}));
const initial = useTimelineStore.getState();
const message = (id: string, text: string) => ({
  type: 'userMessage',
  id,
  content: [{ type: 'text', text }],
});
const users = () =>
  useTimelineStore
    .getState()
    .getThreadRuntime('a')!
    .timeline.filter((entry) => entry.kind === 'user');

beforeEach(() => {
  useTimelineStore.setState(initial, true);
  const store = useTimelineStore.getState();
  store.selectThread('a');
  store.addUserMessage('Initial');
  store.setActiveTurnIdForThread('a', 'turn');
  store.updateCurrentTurnForThread('a', 'turn', () => ({
    items: [
      {
        type: 'reasoning',
        itemId: 'thinking',
        content: 'En réflexion',
        completed: false,
      },
    ],
    completed: false,
  }));
  store.upsertUserMessageForThread('a', 'turn', {
    itemId: 'original',
    text: 'Initial',
    images: [],
  });
});

it('shows an instruction immediately without starting or interrupting another turn', () => {
  beginSteerSubmission('a', 'turn', [
    { type: 'text', text: 'Ajoute les tests' },
    { type: 'localImage', path: '/image.png' },
  ]);
  expect(users().map((entry) => entry.content)).toEqual([
    'Initial',
    'Ajoute les tests',
  ]);
  expect(users()[1]).toMatchObject({
    steering: true,
    turnId: 'turn',
    images: ['/image.png'],
  });
  expect(useTimelineStore.getState().getThreadRuntime('a')).toMatchObject({
    activeTurnId: 'turn',
    turnStartPending: false,
  });
});

it('settles repeated identical instructions by occurrence and ignores duplicate native events', () => {
  beginSteerSubmission('a', 'turn', [{ type: 'text', text: 'Continue' }]);
  beginSteerSubmission('a', 'turn', [{ type: 'text', text: 'Continue' }]);
  const ctx = {
    threadId: 'a',
    upsertUserMessage: (turnId, input) =>
      useTimelineStore
        .getState()
        .upsertUserMessageForThread('a', turnId, input),
  } as NotificationContext;
  for (const id of ['one', 'two']) {
    const event = {
      threadId: 'a',
      turnId: 'turn',
      item: message(id, 'Continue'),
    };
    handleItemStarted(event, ctx);
    handleItemCompleted(event, ctx);
    handleItemStarted(event, ctx);
  }
  expect(users()).toHaveLength(3);
  expect(users().map((entry) => entry.itemId)).toEqual([
    'original',
    'one',
    'two',
  ]);
});

it('routes a refusal to the originating agent and removes only its unconfirmed instruction', () => {
  const pending = beginSteerSubmission('a', 'turn', [
    { type: 'text', text: 'Refusée' },
  ]);
  const confirmed = beginSteerSubmission('a', 'turn', [
    { type: 'text', text: 'Reçue' },
  ]);
  useTimelineStore
    .getState()
    .upsertUserMessageForThread('a', 'turn', {
      itemId: 'echo',
      text: 'Reçue',
      images: [],
    });
  useTimelineStore.getState().selectThread('b');
  rejectSteerSubmission(pending, new Error('Refus explicite'));
  rejectSteerSubmission(
    confirmed,
    new Error('Transport interrompu après confirmation'),
  );
  expect(users().map((entry) => entry.content)).toEqual(['Initial', 'Reçue']);
  expect(useTimelineStore.getState().timeline).toEqual([]);
  expect(useTimelineStore.getState().getThreadRuntime('a')!.activeTurnId).toBe(
    'turn',
  );
});

it('retains every instruction on cold hydration and partial-item recovery', () => {
  const items = [
    message('original', 'Initial'),
    message('one', 'Continue'),
    message('two', 'Continue'),
  ];
  const history = turnsToTimeline([
    { id: 'turn', status: 'inProgress', items } as unknown as TurnDto,
  ]);
  expect(history.filter((entry) => entry.kind === 'user')).toMatchObject([
    { itemId: 'original', content: 'Initial' },
    { itemId: 'one', steering: true },
    { itemId: 'two', steering: true },
  ]);
  beginSteerSubmission('a', 'turn', [{ type: 'text', text: 'Continue' }]);
  useTimelineStore.getState().applyFullTurnItemsForThread('a', 'turn', items);
  expect(users()).toHaveLength(3);
  useTimelineStore.getState().applyFullTurnItemsForThread('a', 'turn', items);
  expect(users()).toHaveLength(3);
  const merged = reconcileTimeline(
    history,
    useTimelineStore.getState().getThreadRuntime('a')!.timeline,
  );
  expect(
    merged
      .filter((entry) => entry.kind === 'user')
      .map((entry) => entry.itemId),
  ).toEqual(['original', 'one', 'two']);
});

it('recovers a missing instruction even when the live timeline already has another user row in that turn', () => {
  const history = turnsToTimeline([
    {
      id: 'turn',
      status: 'inProgress',
      items: [
        message('original', 'Initial'),
        message('missing', 'Instruction distante'),
      ],
    } as unknown as TurnDto,
  ]);
  const merged = reconcileTimeline(
    history,
    useTimelineStore.getState().getThreadRuntime('a')!.timeline,
  );
  expect(
    merged
      .filter((entry) => entry.kind === 'user')
      .map((entry) => entry.content),
  ).toEqual(['Initial', 'Instruction distante']);
});

it('does not resurrect a forgotten agent on late submission failure', () => {
  const pending = beginSteerSubmission('a', 'turn', [
    { type: 'text', text: 'Bonjour' },
  ]);
  useTimelineStore.getState().forgetThreads(['a']);
  rejectSteerSubmission(pending, new Error('Late'));
  expect(useTimelineStore.getState().getThreadRuntime('a')).toBeNull();
});
