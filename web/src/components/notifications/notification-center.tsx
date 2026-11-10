import { subscribeInboxErrors } from '@/lib/inbox-errors';
import {
  inboxApi,
  key,
  useInbox,
  useInboxStore,
  type InboxItem,
} from './inbox-state';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Bell,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  Mail,
  MailOpen,
  MessageCircleQuestion,
  ShieldQuestion,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePlatformSession } from '@/lib/platform-session';
import { useSnackbarStore } from '@/stores/snackbar-store';

export function NotificationBell() {
  const { t } = useTranslation(['notifications', 'common'], {
    nsMode: 'fallback',
  });
  const { query, enabled } = useInbox();
  const { open, toggle } = useInboxStore();
  const unread =
    enabled && !query.isError ? (query.data?.pages[0]?.unread ?? 0) : 0;
  return (
    <Button
      size="icon"
      variant="ghost"
      className="relative size-8 shrink-0"
      disabled={!enabled}
      aria-label={t('inboxTitle')}
      aria-expanded={open}
      aria-controls="notification-center"
      aria-description={t('inboxUnreadCount', { count: unread })}
      onClick={toggle}
    >
      <Bell className="size-4" />
      {unread > 0 && (
        <span
          className="absolute -right-1 -top-1 min-w-4 rounded-full bg-destructive px-1 text-[10px] text-white"
          aria-label={t('inboxUnreadCount', { count: unread })}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Button>
  );
}
export function NotificationCenter() {
  const { t, i18n } = useTranslation(['notifications', 'common'], {
    nsMode: 'fallback',
  });
  const { query, id, enabled } = useInbox();
  const client = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const state = useInboxStore();
  const [error, setError] = useState(false);
  useEffect(() => {
    useInboxStore.getState().close();
    return () => {
      client.removeQueries({ queryKey: key(id) });
    };
  }, [id, client]); // Person changes close the personal inbox; route changes do not.
  useEffect(() => {
    if (!enabled) return;
    let seen = new Set(
      useSnackbarStore
        .getState()
        .visible.concat(useSnackbarStore.getState().queue)
        .map((n) => n.id),
    );
    return useSnackbarStore.subscribe((s) => {
      const all = s.visible.concat(s.queue);
      const next = new Set(all.map((n) => n.id));
      for (const n of all) {
        if (n.severity !== 'error' || seen.has(n.id)) continue;
        const thread = /^\/t\/([^/]+)/.exec(pathname)?.[1];
        const project = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
        void inboxApi(
          '/errors',
          {
            message: n.message.slice(0, 1000),
            ...(thread
              ? { threadId: thread }
              : project
                ? { projectId: project }
                : {}),
          },
          'POST',
        )
          .then(() => client.invalidateQueries({ queryKey: key(id) }))
          .catch(() => {});
      }
      seen = next;
    });
  }, [id, enabled, pathname, client]);
  useEffect(() => {
    if (!enabled) return;
    return subscribeInboxErrors(({ threadId, message }) => {
      void inboxApi(
        '/errors',
        { threadId, message: message.slice(0, 1000) },
        'POST',
      )
        .then(() => client.invalidateQueries({ queryKey: key(id) }))
        .catch(() => {});
    });
  }, [id, enabled, client]);
  const mark = useMutation({
    mutationFn: ({ item, read }: { item: InboxItem | string; read: boolean }) =>
      inboxApi(
        '/' +
          encodeURIComponent(typeof item === 'string' ? item : item.id) +
          '/read',
        { read },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key(id) }),
    onError: () => {
      setError(true);
      void client.invalidateQueries({ queryKey: key(id) });
    },
  });
  const items =
    enabled && !query.isError
      ? (query.data?.pages.flatMap((p) => p.items) ?? [])
      : [];
  const unique = [...new Map(items.map((n) => [n.id, n])).values()];
  const groups = new Map<string, InboxItem[]>();
  for (const n of unique) {
    const group =
      state.grouping === 'project' ? (n.projectId ?? 'general') : '';
    groups.set(group, [...(groups.get(group) ?? []), n]);
  }
  if (!state.open) return null;
  return (
    <aside
      id="notification-center"
      role="region"
      onKeyDown={(event) => {
        if (event.key === 'Escape') state.close();
      }}
      aria-label={t('inboxTitle')}
      className="fixed inset-y-0 right-0 z-50 flex min-h-0 w-full max-w-[420px] flex-col overflow-hidden border-l bg-background shadow-xl"
    >
      <header className="shrink-0 space-y-3 border-b bg-background p-4">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-base font-semibold">{t('inboxTitle')}</h2>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('close')}
            onClick={state.close}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label={t('inboxReadFilter')}
            className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm"
            value={state.filter}
            onChange={(e) => state.setFilter(e.target.value)}
          >
            <option value="all">{t('inboxAll')}</option>
            <option value="unread">{t('inboxUnread')}</option>
            <option value="read">{t('inboxRead')}</option>
          </select>
          <select
            aria-label={t('inboxGrouping')}
            className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm"
            value={state.grouping}
            onChange={(e) => state.setGrouping(e.target.value)}
          >
            <option value="date">{t('inboxByDate')}</option>
            <option value="project">{t('inboxByProject')}</option>
          </select>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!enabled || mark.isPending || query.isError}
          onClick={() => mark.mutate({ item: 'all', read: true })}
        >
          <CheckCheck className="size-4" />
          {t('inboxMarkAll')}
        </Button>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        tabIndex={0}
        aria-label={t('inboxList')}
      >
        {(query.isError || error) && (
          <p role="alert" className="p-4 text-sm text-destructive">
            {t('inboxLoadError')}
          </p>
        )}
        {!enabled ? (
          <p className="p-4 text-sm">{t('inboxSessionRequired')}</p>
        ) : query.isPending ? (
          <p role="status" className="p-4 text-sm">
            {t('loading')}
          </p>
        ) : !unique.length && !query.isError ? (
          <p className="p-6 text-sm text-muted-foreground">{t('inboxEmpty')}</p>
        ) : null}
        {[...groups].map(([group, rows]) => (
          <section key={group}>
            {group && (
              <h3 className="border-b bg-muted px-4 py-2 text-sm font-medium">
                {rows[0]?.projectName ?? t('inboxGeneral')}
              </h3>
            )}
            {rows.map((n) => {
              const Icon =
                n.kind === 'error'
                  ? CircleAlert
                  : n.kind === 'completed'
                    ? CircleCheck
                    : n.kind === 'question'
                      ? MessageCircleQuestion
                      : ShieldQuestion;
              return (
                <article
                  key={n.id}
                  className={
                    'flex gap-3 border-b p-4 ' +
                    (n.readAt === null ? 'bg-accent/40' : '')
                  }
                >
                  <Icon
                    aria-hidden="true"
                    className={
                      'mt-1 size-5 shrink-0 ' +
                      (n.kind === 'error'
                        ? 'text-destructive'
                        : n.kind === 'completed'
                          ? 'text-emerald-600'
                          : 'text-amber-600')
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <button
                      className="w-full whitespace-pre-wrap break-words text-left text-sm font-medium hover:underline disabled:no-underline"
                      disabled={mark.isPending}
                      onClick={async () => {
                        setError(false);
                        try {
                          await mark.mutateAsync({ item: n, read: true });
                          if (n.threadId)
                            await navigate({
                              to: '/t/$threadId',
                              params: { threadId: n.threadId },
                            });
                          else if (n.projectId)
                            await navigate({
                              to: '/projects/$projectId',
                              params: { projectId: n.projectId },
                            });
                        } catch {
                          setError(true);
                        }
                      }}
                    >
                      {n.message ||
                        t(
                          n.kind === 'completed'
                            ? 'inboxCompleted'
                            : n.kind === 'error'
                              ? 'inboxAgentError'
                              : n.kind === 'question'
                                ? 'inboxQuestion'
                                : 'inboxApproval',
                        )}
                    </button>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {n.projectName ?? t('inboxGeneral')} ·{' '}
                      {new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(n.createdAt)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(n.readAt === null ? 'inboxUnread' : 'inboxRead')}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 shrink-0"
                    disabled={mark.isPending}
                    aria-label={t(
                      n.readAt === null ? 'inboxMarkRead' : 'inboxMarkUnread',
                    )}
                    onClick={() =>
                      mark.mutate({ item: n, read: n.readAt === null })
                    }
                  >
                    {n.readAt === null ? (
                      <Mail className="size-4" />
                    ) : (
                      <MailOpen className="size-4" />
                    )}
                  </Button>
                </article>
              );
            })}
          </section>
        ))}
        {query.hasNextPage && (
          <Button
            className="m-4"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t('inboxMore')}
          </Button>
        )}
      </div>
    </aside>
  );
}
export function NotificationPreferences() {
  const { t } = useTranslation(['notifications', 'common'], {
    nsMode: 'fallback',
  });
  const session = usePlatformSession();
  const id = session.data?.personId;
  const client = useQueryClient();
  const [draft, setDraft] = useState<number | null>(null);
  const query = useQuery({
    queryKey: ['notification-preferences', id],
    queryFn: () => inboxApi<{ retentionDays: number }>('/preferences'),
    enabled: !!id && !session.data?.impersonation,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => inboxApi('/preferences', { retentionDays: draft }),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['notification-preferences', id],
      });
      await client.invalidateQueries({ queryKey: key(id) });
      setDraft(null);
    },
  });
  return (
    <section className="space-y-2 border-t pt-4">
      <h3 className="text-sm font-medium">{t('inboxTitle')}</h3>
      <label className="block text-sm" htmlFor="notification-retention">
        {t('inboxRetention')}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="notification-retention"
          type="number"
          min={1}
          max={365}
          className="w-24"
          value={draft ?? query.data?.retentionDays ?? 7}
          disabled={!query.data || save.isPending}
          onChange={(e) => setDraft(e.target.valueAsNumber)}
        />
        <span className="text-sm">{t('inboxDays')}</span>
        <Button
          size="sm"
          disabled={
            !Number.isInteger(draft) ||
            draft === null ||
            draft < 1 ||
            draft > 365 ||
            save.isPending
          }
          onClick={() => save.mutate()}
        >
          {t('save')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('inboxRetentionHint')}</p>
      {(query.isError || save.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {t('inboxLoadError')}
        </p>
      )}
    </section>
  );
}
