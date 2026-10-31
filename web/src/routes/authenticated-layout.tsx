/**
 * Authenticated layout: sidebar + header + main content outlet.
 * Replaces the old App.tsx conditional rendering.
 */
import { useEffect, useState } from 'react';
import { RetainedSurface } from '@/components/retained-surface';
import { readManagerUpdateReceipt } from '@/components/settings/manager-update-recovery';
import { ManagerUpdateReconnecting } from '@/components/settings/manager-update-reconnecting';
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
import {
  SIDEBAR_REGION_ID,
  useLayoutStore,
  desktopSidebarCollapsedForPath,
} from '@/stores/layout-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { isThemeId, useThemeStore } from '@/stores/theme-store';
import { cn } from '@/lib/utils';
import { filesGetRoots, filesAddRoot } from '@/generated/api';
import {
  AuthRedirectError,
  AuthResourceError,
  AuthIdentityChangedError,
  isSessionTransportError,
  readAuthResource,
  usePlatformSession,
  type PlatformSession,
} from '@/lib/platform-session';
import { sessionOwner } from '@/lib/session-recovery';
import { useSessionRenewal } from '@/lib/session-renewal';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { isSupportedLocale } from '@/locales';
import { ImpersonationBanner } from '@/components/impersonation-controls';
import { installBrowserWorkspaceSessions } from '@/lib/browser-workspace-sessions';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { AgentWorkspaceHost } from '@/components/chat/agent-workspace-host';

/**
 * Bound on retained per-conversation state.
 *
 * Named for subscriptions historically, and it still unsubscribes what it
 * evicts. There is normally one room, plus the recently visited views of a
 * project opting into fast navigation. It bounds the runtime cache — including the
 * conversations attention delivery creates state for without ever opening.
 */
const DEFAULT_MAX_IDLE_SUBSCRIPTIONS = 30;
const IDLE_SUBSCRIPTION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function AuthenticatedLayout() {
  return <AuthenticatedContent />;
}

function AuthenticatedContent() {
  const session = usePlatformSession();
  const [retained, setRetained] = useState<PlatformSession | null>(null);
  const verified =
    !session.paused &&
    !session.isPending &&
    !session.isError &&
    session.data?.active;
  const changed =
    session.error instanceof AuthIdentityChangedError ||
    Boolean(
      verified &&
      retained &&
      sessionOwner(retained) !== sessionOwner(session.data!),
    );
  if (verified && !changed && session.data !== retained)
    setRetained(session.data!);
  const ready = Boolean(verified && !changed);

  return (
    <>
      {/* Activity retains React/DOM state but cleans up effects and portals while
          hidden. Cached identity never grants access during verification. */}
      <RetainedSurface active={ready}>
        {retained && (
          <div className="flex h-full min-h-0 flex-col">
            <ImpersonationBanner />
            <div className="min-h-0 flex-1">
              <AuthenticatedWorkspace
                isAdministrator={retained.role === 'administrator'}
                browserOwner={JSON.stringify([
                  retained.personId ?? retained.subject ?? retained.kind,
                  retained.impersonation?.sessionId ?? '',
                ])}
                profileTheme={retained.theme}
                profileLanguage={retained.language}
              />
            </div>
          </div>
        )}
      </RetainedSurface>
      {!ready && (
        <SessionRecovery
          session={session}
          changed={changed}
          retained={retained !== null}
        />
      )}
    </>
  );
}

function SessionRecovery({
  session,
  changed,
  retained,
}: {
  session: ReturnType<typeof usePlatformSession>;
  changed: boolean;
  retained: boolean;
}) {
  const { t } = useTranslation('authentication');
  const renewal = useSessionRenewal(
    () => void session.refetch({ cancelRefetch: false }),
  );
  const reconnecting = isSessionTransportError(session.error);
  const proxyExpired =
    session.error instanceof AuthRedirectError ||
    (session.error instanceof AuthResourceError &&
      session.error.status === 401);
  const checking =
    session.isPending ||
    (session.paused && !session.isError && session.data?.active);
  // A local receipt only restores progress display, never the authenticated workspace.
  if (session.isPending || (session.isError && reconnecting)) {
    const receipt = readManagerUpdateReceipt();
    // This recovery view must already be loaded before the server goes offline.
    // A lazy import here would require a network request precisely during downtime.
    if (receipt) return <ManagerUpdateReconnecting receipt={receipt} />;
  }
  if (session.isPending && !retained)
    return <div className="p-6">{t('access.verifying')}</div>;
  const content = (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">
        {(reconnecting || checking) && (
          <LoaderCircle
            aria-hidden="true"
            className="mr-2 inline size-5 animate-spin"
          />
        )}
        {t(
          changed
            ? 'access.identityChanged'
            : checking
              ? 'access.verifying'
              : reconnecting
                ? 'access.reconnecting'
                : proxyExpired
                  ? 'access.sessionExpired'
                  : 'access.unavailable',
        )}
      </h1>
      <p>
        {t(
          changed
            ? 'access.identityChangedHelp'
            : checking
              ? 'access.retained'
              : reconnecting
                ? 'access.connectionInterrupted'
                : proxyExpired
                  ? 'access.proxySessionExpired'
                  : session.isError
                    ? 'access.verificationError'
                    : 'access.inactivePerson',
        )}
      </p>
      {retained && !checking && <p>{t('access.retained')}</p>}
      {!session.isError &&
        !checking &&
        !changed &&
        !session.data?.active &&
        session.data?.email && <p>{session.data.email}</p>}
      {!session.isError &&
        !checking &&
        !changed &&
        !session.data?.active &&
        session.data?.subject && (
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
          onClick={() => renewal.open()}
        >
          {t('access.restoreConnection')}
        </button>
      )}
      {!reconnecting && !checking && (
        <button
          className="cursor-pointer rounded-md border px-4 py-2 hover:bg-accent"
          onClick={() => renewal.open(true)}
        >
          {t('access.anotherMethod')}
        </button>
      )}
      {renewal.popupBlocked && <p role="alert">{t('access.popupBlocked')}</p>}
    </main>
  );
  if (!retained) return content;
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-xl"
      >
        <DialogTitle className="sr-only">
          {t('access.sessionExpired')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t('access.retained')}
        </DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  );
}

function AuthenticatedWorkspace({
  isAdministrator,
  profileTheme,
  profileLanguage,
  browserOwner,
}: {
  isAdministrator: boolean;
  profileTheme?: string;
  profileLanguage?: string;
  browserOwner: string;
}) {
  useEffect(() => {
    if (!isAdministrator) {
      useWorkspaceStore.getState().restoreBrowsers({});
      return;
    }
    return installBrowserWorkspaceSessions(browserOwner);
  }, [browserOwner, isAdministrator]);
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
  const desktopSidebarCollapsed = useLayoutStore((s) =>
    desktopSidebarCollapsedForPath(s, pathname),
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
            <>
              <Outlet />
              <AgentWorkspaceHost
                activeThreadId={/^\/t\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null}
              />
            </>
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
