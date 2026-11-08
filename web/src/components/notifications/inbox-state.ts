import { create } from 'zustand';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { usePlatformSession } from '@/lib/platform-session';
import { useSessionPaused } from '@/lib/session-recovery';
export interface InboxItem {
  id: string;
  projectId: string | null;
  projectName: string | null;
  threadId: string | null;
  kind: string;
  message: string;
  readAt: number | null;
  createdAt: number;
}
interface InboxPage {
  items: InboxItem[];
  unread: number;
  nextCursor: string | null;
}
export function parseInboxPage(value: unknown): InboxPage {
  if (!value || typeof value !== 'object')
    throw new Error('notificationsUnavailable');
  const page = value as InboxPage;
  if (
    !Array.isArray(page.items) ||
    !Number.isInteger(page.unread) ||
    page.unread < 0 ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string') ||
    !page.items.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.kind === 'string' &&
        typeof item.message === 'string' &&
        Number.isFinite(item.createdAt) &&
        (item.readAt === null || Number.isFinite(item.readAt)) &&
        [item.projectId, item.projectName, item.threadId].every(
          (v) => v === null || typeof v === 'string',
        ),
    )
  )
    throw new Error('notificationsUnavailable');
  return page;
}
export async function inboxApi<T>(
  path = '',
  body?: unknown,
  method = body === undefined ? 'GET' : 'PATCH',
): Promise<T> {
  const auth = getAuthorizationHeader();
  const r = await fetch(withBasePath('/api/notifications' + path), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      ...(auth ? { Authorization: auth } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error('notificationsUnavailable');
  return r.json();
}
export const useInboxStore = create<{
  open: boolean;
  filter: string;
  grouping: string;
  toggle: () => void;
  close: () => void;
  setFilter: (v: string) => void;
  setGrouping: (v: string) => void;
}>((set) => ({
  open: false,
  filter: 'all',
  grouping: 'date',
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
  setFilter: (filter) => set({ filter }),
  setGrouping: (grouping) => set({ grouping }),
}));
export const key = (id: string | null | undefined) => [
  'notification-inbox',
  id,
];
export function useInbox() {
  const session = usePlatformSession();
  const paused = useSessionPaused();
  const id = session.data?.personId;
  const { filter } = useInboxStore();
  const enabled =
    !!id &&
    session.data?.kind === 'person' &&
    session.data.active &&
    !session.data.impersonation &&
    !paused;
  const query = useInfiniteQuery({
    queryKey: [...key(id), filter],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      parseInboxPage(
        await inboxApi<unknown>(
          '?filter=' +
            filter +
            (pageParam ? '&cursor=' + encodeURIComponent(pageParam) : ''),
        ),
      ),
    getNextPageParam: (p) => p.nextCursor,
    enabled,
    refetchInterval: 10000,
    retry: false,
  });
  return { query, id, enabled };
}
