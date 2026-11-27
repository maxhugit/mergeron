import { beforeEach, expect, it } from 'vitest';
import { useAgentCompletionStore as completion } from './agent-completion-store';

beforeEach(() => completion.getState().clear());
it('acknowledges only the opened agent and ignores replayed completions', () => {
  const store = completion.getState();
  store.complete('a', 'first');
  store.complete('b', 'other');
  store.acknowledge(['a']);
  store.complete('a', 'first');
  expect([...completion.getState().unread]).toEqual(['b']);
  store.complete('a', 'second');
  expect(completion.getState().unread.has('a')).toBe(true);
  store.acknowledge(['a', 'b']);
  expect(completion.getState().unread.size).toBe(0);
});
it('clears all completion information at the session boundary', () => {
  completion.getState().complete('a', 'turn');
  completion.getState().clear();
  expect(completion.getState().unread.size).toBe(0);
  expect(completion.getState().seen.size).toBe(0);
});
