import { expect, it } from 'vitest';
import { parseInboxPage } from './inbox-state';

it.each([
  null,
  {},
  { maxIdleSubscriptions: 30 },
  { items: [undefined], unread: 1, nextCursor: null },
  { items: [], unread: -1, nextCursor: null },
])(
  'rejects an invalid response instead of crashing the global layout: %j',
  (body) => {
    expect(() => parseInboxPage(body)).toThrow('notificationsUnavailable');
  },
);
it('accepts an empty inbox without inventing entries or a counter', () => {
  expect(parseInboxPage({ items: [], unread: 0, nextCursor: null })).toEqual({
    items: [],
    unread: 0,
    nextCursor: null,
  });
});
