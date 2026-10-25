/**
 * Authenticated layout: sidebar + header + main content outlet.
 * Replaces the old App.tsx conditional rendering.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { readManagerUpdateReceipt } from '@/components/settings/manager-update-recovery';
import { LoaderCircle } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { DetachedDocumentRecovery } from '@/components/files/detached-document-recovery';
import { TerminalHost } from '@/components/terminal/terminal-host';
import { ChatHeader } from '@/components/chat/chat-header';
import { ThreadSidebar } from '@/components/chat/thread-sidebar';
import { SettingsSidebar } from '@/components/settings/settings-sidebar';
import { SnackbarContainer } from '@/components/snackbar/snackbar-container';
import { CodexStatusBanner } from '@/components/codex-status-banner';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useCodexSocket } from '@/hooks/use-codex-socket';
import { useGlobalFilesStore } from '@/stores/files-store';
import { GlobalFilesHost } from '@/components/files/global-files-host';
import { installFileReconciler } from '@/lib/file-reconciler';
import { SIDEBAR_REGION_ID, useLayoutStore } from '@/stores/layout-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { isThemeId, useThemeStore } from '@/stores/theme-store';
import { cn } from '@/lib/utils';
import { clearApiToken } from '@/auth-token';
import { resetSocket } from '@/socket';
import { filesGetRoots, filesAddRoot } from '@/generated/api';
import {
  AuthRedirectError,
  isSessionTransportError,
  readAuthResource,
  usePlatformSession,
} from '@/lib/platform-session';
import { isSupportedLocale } from '@/locales';
import { MobileRefresh } from '@/components/mobile-refresh';

/**
 * Bound on retained per-conversation state.
 *
 * Named for subscriptions historically, and it still unsubscribes what it
 * evicts, but with rooms following the visible transcript there is rarely more
 * than one. What it actually bounds now is the runtime cache — including the
 * conversations attention delivery creates state for without ever opening.
 */
const DEFAULT_MAX_IDLE_SUBSCRIPTIONS = 30;
const IDLE_SUBSCRIPTION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const ManagerUpdateReconnecting = lazy(() =>
  import('@/components/settings/manager-update-reconnecting').then(
    (module) => ({ default: module.ManagerUpdateReconnecting }),
  ),
);

export function AuthenticatedLayout() {
  const session = usePlatformSession();
  const { t } = useTranslation('authentication');
  const navigate = useNavigate();
  const reconnecting = isSessionTransportError(session.error);
  const proxyExpired = session.error instanceof AuthRedirectError;
  // A local receipt only restores progress display, never the authenticated workspace.
  if (session.isPending || (session.isError && reconnecting)) {
    const receipt = readManagerUpdateReceipt();
    if (receipt)
      return (
        <Suspense
          fallback={<div className="p-6">{t('access.reconnecting')}</div>}
        >
          <ManagerUpdateReconnecting receipt={receipt} />
        </Suspense>
      );
  }
  if (session.isPending)
    return <div className="p-6">{t('access.verifying')}</div>;
  if (session.isError || !session.data?.active)
    return (
      <main className="mx-auto max-w-xl space-y-4 p-6">
        <h1 className="text-xl font-semibold">
          {reconnecting && (
            <LoaderCircle
              aria-hidden="true"
              className="mr-2 inline size-5 animate-spin"
            />
          )}
          {t(
            reconnecting
              ? 'access.reconnecting'
              : proxyExpired
                ? 'access.sessionExpired'
                : 'access.unavailable',
          )}
        </h1>
        <p>
          {t(
            reconnecting
              ? 'access.connectionInterrupted'
              : proxyExpired
                ? 'access.proxySessionExpired'
                : session.isError
                  ? 'access.verificationError'
                  : 'access.inactivePerson',
          )}
        </p>
        {!session.isError && session.data?.email && <p>{session.data.email}</p>}
        {!session.isError && session.data?.subject && (
          <p className="break-all text-xs">
            {t('access.reference')}: {session.data.subject}
          </p>
        )}
        <button
          className="cursor-pointer rounded-md border px-4 py-2 hover:bg-accent"
          onClick={() => void session.refetch()}
        >
          {t('access.retry')}
        </button>
        {proxyExpired && (
          <button
            className="cursor-pointer rounded-md border px-4 py-2 hover:bg-accent"
            onClick={() => window.location.reload()}
          >
            {t('access.restoreConnection')}
          </button>
        )}
        {!reconnecting && (
          <button
            className="cursor-pointer rounded-md border px-4 py-2 hover:bg-accent"
            onClick={() =>
              void navigate({
                to: '/login',
                search: { redirect: window.location.pathname, manual: true },
              })
            }
          >
            {t('access.anotherMethod')}
          </button>
        )}
      </main>
    );
  return (
    <AuthenticatedWorkspace
      key={session.data.personId ?? session.data.kind}
      isAdministrator={session.isAdministrator}
      profileTheme={session.data.theme}
      profileLanguage={session.data.language}
    />
  );
}

function AuthenticatedWorkspace({
  isAdministrator,
  profileTheme,
  profileLanguage,
}: {
  isAdministrator: boolean;
  profileTheme?: string;
  profileLanguage?: string;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const administrationView = [
    '/settings',
    '/files',
    '/terminal',
    '/diagnostics',
    '/logs',
  ].some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const adminOnlyView =
    administrationView ||
    pathname === '/integrations' ||
    pathname.startsWith('/integrations/');
  const [filesDefaultRoot, setFilesDefaultRoot] = useState<string | null>(null);

  const setMaxIdleSubscriptions = useTimelineStore(
    (s) => s.setMaxIdleSubscriptions,
  );
  const cleanupIdleThreadSubscriptions = useTimelineStore(
    (s) => s.cleanupIdleThreadSubscriptions,
  );
  const setRootDir = useGlobalFilesStore((s) => s.setRootDir);
  const setTheme = useThemeStore((s) => s.setTheme);
  const generalSettingsQuery = useQuery({
    queryKey: ['platform-client-config'],
    queryFn: () =>
      readAuthResource<{ maxIdleSubscriptions: number }>('client-config'),
  });
  const maxIdleSubscriptions =
    generalSettingsQuery.data?.maxIdleSubscriptions ??
    DEFAULT_MAX_IDLE_SUBSCRIPTIONS;

  useCodexSocket(true);

  const queryClient = useQueryClient();
  useEffect(() => installFileReconciler(queryClient), [queryClient]);

  useEffect(() => {
    setMaxIdleSubscriptions(maxIdleSubscriptions);
  }, [maxIdleSubscriptions, setMaxIdleSubscriptions]);

  useEffect(() => {
    const timer = window.setInterval(
      () => cleanupIdleThreadSubscriptions(maxIdleSubscriptions),
      IDLE_SUBSCRIPTION_CLEANUP_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [cleanupIdleThreadSubscriptions, maxIdleSubscriptions]);

  // Prefer the configured workspace tree for the standalone browser. Falling
  // back to home made /files briefly show the previous workspace and then jump
  // to the container's private home directory.
  useEffect(() => {
    filesGetRoots({ throwOnError: true })
      .then(({ data }) => {
        const workspaceRoot = data.roots.find(
          (root) => root === '/workspaces' || root.endsWith('/workspaces'),
        );
        setFilesDefaultRoot(workspaceRoot ?? data.roots[0] ?? data.homeDir);
      })
      .catch(() => undefined);
  }, []);

  // Handle snackbar jump-to-thread actions.
  useEffect(() => {
    const handleJump = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: string }>).detail
        ?.threadId;
      if (!threadId) return;
      void navigate({ to: '/t/$threadId', params: { threadId } });
    };
    window.addEventListener('codex-webui:jump-thread', handleJump);
    return () =>
      window.removeEventListener('codex-webui:jump-thread', handleJump);
  }, [navigate]);

  // Handle auth expiry → redirect to /login
  useEffect(() => {
    const handleAuthExpired = () => {
      clearApiToken();
      resetSocket();
      void navigate({ to: '/login', search: { redirect: '/' } });
    };
    window.addEventListener('codex-webui:auth-expired', handleAuthExpired);
    return () =>
      window.removeEventListener('codex-webui:auth-expired', handleAuthExpired);
  }, [navigate]);

  // Conversation roots are adopted by their keyed WorkspaceTree. This owner
  // handles the standalone browser only, so late metadata cannot reset browsing.
  useEffect(() => {
    let cancelled = false;
    const dir =
      pathname.startsWith('/files') && !useGlobalFilesStore.getState().rootDir
        ? filesDefaultRoot
        : null;
    // Initialize only an empty standalone browser. A route change must never
    // replace the user's browsed folder or clear its selected document.
    if (dir) {
      // A rejected root is still shown: the tree reports the directory it
      // cannot read, instead of silently leaving the previous one on screen.
      void filesAddRoot({
        body: { root: dir },
        throwOnError: true,
        meta: { silent: true },
      })
        .then(() => {
          if (!cancelled && !useGlobalFilesStore.getState().rootDir)
            setRootDir(dir);
        })
        .catch(() => {
          if (!cancelled && !useGlobalFilesStore.getState().rootDir)
            setRootDir(dir);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [pathname, filesDefaultRoot, setRootDir]);

  const { t, i18n } = useTranslation();

  useEffect(() => {
    if (isThemeId(profileTheme)) setTheme(profileTheme);
    if (isSupportedLocale(profileLanguage))
      void i18n.changeLanguage(profileLanguage);
  }, [i18n, profileLanguage, profileTheme, setTheme]);

  // ── Responsive layout ────────────────────────────────────────────────
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const setSidebarOpen = useLayoutStore((s) => s.setSidebarOpen);
  const desktopSidebarCollapsed = useLayoutStore(
    (s) => s.desktopSidebarCollapsed,
  );

  // Auto-close sidebar sheet on route change
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname, setSidebarOpen]);

  // Auto-close sidebar sheet when entering desktop breakpoint
  useEffect(() => {
    if (isDesktop) setSidebarOpen(false);
  }, [isDesktop, setSidebarOpen]);

  return (
    <TooltipProvider>
      <MobileRefresh />
      <div className="flex h-full overflow-hidden bg-background">
        {/* Desktop: inline sidebar with collapse animation */}
        {isDesktop && (
          <aside
            id={SIDEBAR_REGION_ID}
            className={cn(
              'relative z-10 shrink-0 overflow-hidden border-r border-[var(--glass-border-subtle)] transition-[width] duration-200 ease-in-out',
              desktopSidebarCollapsed ? 'w-0 border-r-0' : 'w-64',
            )}
          >
            <div className="flex h-full w-64 flex-col">
              {administrationView && isAdministrator ? (
                <SettingsSidebar />
              ) : (
                <ThreadSidebar />
              )}
            </div>
          </aside>
        )}

        {/* Mobile/Tablet: sidebar as Sheet overlay */}
        {!isDesktop && (
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent
              side="left"
              className="mobile-sidebar-sheet !w-[280px] p-0 sm:!max-w-[320px]"
              showCloseButton={false}
            >
              <SheetTitle className="sr-only">{t('navigation')}</SheetTitle>
              {administrationView && isAdministrator ? (
                <SettingsSidebar />
              ) : (
                <ThreadSidebar />
              )}
            </SheetContent>
          </Sheet>
        )}

        {/* Isolated so nothing in this column can paint over the sidebar —
            measured: without it, a positive z-index here covers the sidebar.
            Note this also makes the column a backdrop root, so a
            `backdrop-filter` inside it samples nothing. That is why the
            composer is an opaque surface rather than a glass one; the
            transcript fades out under it instead. See chat-input.tsx. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col isolate">
          {!pathname.startsWith('/t/') && <ChatHeader />}
          <CodexStatusBanner />
          <DetachedDocumentRecovery />
          {adminOnlyView && !isAdministrator ? (
            <div role="alert" className="p-6">
              {t('administratorAccessRequired')}
            </div>
          ) : (
            <Outlet />
          )}
          {isAdministrator && (
            <GlobalFilesHost active={pathname === '/files'} />
          )}
        </div>
      </div>
      <TerminalHost />
      <SnackbarContainer />
    </TooltipProvider>
  );
}
