import { vi } from 'vitest';
import type { InboxItem } from './inbox-state';
export function inboxFixture(count = 4) {
  const items: InboxItem[] = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    projectId: i % 2 ? 'b' : 'a',
    projectName: i % 2 ? 'Formation' : 'Mergeron',
    threadId: 'agent-' + i,
    kind: i % 2 ? 'completed' : 'error',
    message: 'Notification ' + i,
    readAt: null,
    createdAt: Date.now() - i * 60000,
  }));
  const calls: { path: string; method: string; body: unknown }[] = [];
  let days = 7;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      const method = options?.method ?? 'GET';
      calls.push({ path: url.pathname, method, body });
      let data: unknown = {};
      if (url.pathname.endsWith('/preferences')) {
        if (method === 'PATCH') days = body.retentionDays;
        data = { retentionDays: days };
      } else if (url.pathname.endsWith('/read')) {
        const id = url.pathname.split('/').at(-2);
        items
          .filter((n) => id === 'all' || n.id === id)
          .forEach((n) => (n.readAt = body.read ? Date.now() : null));
      } else if (method === 'GET') {
        const filter = url.searchParams.get('filter');
        data = {
          items: items.filter(
            (n) =>
              filter === 'all' || (filter === 'read') === (n.readAt !== null),
          ),
          unread: items.filter((n) => n.readAt === null).length,
          nextCursor: null,
        };
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { items, calls };
}
