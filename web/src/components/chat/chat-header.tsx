import { translationKey } from '@/locales/translation-key';
import { BrandIcon } from '@/components/brand-icon';
import { PwaInstall } from '@/components/pwa-install';
import { ReloadApplicationButton } from '@/components/reload-application-button';
import { useState } from 'react';
import {
  Check,
  Edit3,
  EllipsisVertical,
  Menu,
  MonitorCog,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  UserRound,
  X,
} from 'lucide-react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  threadsListThreadsQueryKey,
  threadsSetThreadNameMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useConnectionStore } from '@/stores/connection-store';
import {
  SIDEBAR_REGION_ID,
  useLayoutStore,
  desktopSidebarCollapsedForPath,
  isDocumentWindow,
} from '@/stores/layout-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useMessageVersions } from '@/hooks/use-message-branches';
import {
  listSimpleChatThreads,
  simpleChatThreadsQueryKey,
} from '@/lib/simple-chat-api';
import { BranchGraphDialog } from '@/components/branches/branch-graph-dialog';
import { AccountRateLimitBadge } from './account-rate-limit-badge';
import { McpStatusBadge } from './mcp-status-badge';
import { usePlatformSession } from '@/lib/platform-session';
import { ProjectResourceHeader } from '@/components/projects/project-resource-header';
import { ProjectHeader } from '@/components/projects/project-header';
import {
  settingsPageDescription,
  settingsPageLabel,
} from '@/components/settings/setting-helpers';
import type { SettingsSection } from '@/components/settings/settings-sections';
import { ProfileAppearance } from '@/components/account/profile-appearance';
import { PushNotificationSettings } from '@/components/account/push-notification-settings';
import { disconnectPushOnLogout } from '@/lib/push-notifications';
import { clearApiToken } from '@/auth-token';
import { authLogout } from '@/generated/api';
import { resetSocket } from '@/socket';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Mobile overflow menu — closes after each action. */
function MobileOverflowMenu({
  onSettings,
  t,
}: {
  onSettings: () => void;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => {
    fn();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9"
          aria-label={t('moreActions')}
        >
          <EllipsisVertical className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-48 p-1">
        <button
          type="button"
          onClick={() => act(onSettings)}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
        >
          <MonitorCog className="h-4 w-4" /> {t('platformSettings')}
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function ChatHeader() {
  const session = usePlatformSession();
  const { isAdministrator } = session;
  const { t } = useTranslation(['common', 'manager'], { nsMode: 'fallback' });
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const resourceRoute = /^\/projects\/([^/]+)\/resources\/([^/]+)\/?$/.exec(
    pathname,
  );
  const projectRoute = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  const settingsSection = useRouterState({
    select: (s) =>
      (s.location.search as { section?: SettingsSection } | undefined)
        ?.section ?? 'general',
  });
  const simpleChatThreadId = useRouterState({
    select: (s) =>
      s.location.pathname.startsWith('/simple-chat')
        ? (s.location.search as { thread?: string } | undefined)?.thread
        : undefined,
  });
  const connected = useConnectionStore((s) => s.connected);
  const threadId = useTimelineStore((s) => s.threadId);
  const threadTitle = useTimelineStore((s) => s.threadTitle);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const setThreadTitle = useTimelineStore((s) => s.setThreadTitle);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [graphOpen, setGraphOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const queryClient = useQueryClient();

  // The graph is only meaningful once this conversation has more than one
  // version, so the entry point appears with the branches rather than always.
  const { isTracked } = useMessageVersions(threadId);

  // ── Responsive ──────────────────────────────────────────────────────
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const toggleSidebarOpen = useLayoutStore((s) => s.toggleSidebarOpen);
  const desktopSidebarCollapsed = useLayoutStore((s) =>
    desktopSidebarCollapsedForPath(s, pathname),
  );
  const toggleDesktopSidebarCollapsed = useLayoutStore((s) =>
    isDocumentWindow(pathname)
      ? s.toggleDocumentSidebarCollapsed
      : s.toggleDesktopSidebarCollapsed,
  );

  // The timeline store deliberately keeps the last opened Codex thread warm
  // while the user visits another screen.  That cached identity must not leak
  // into global pages such as Simple Chat, Files or Settings.
  const visibleThreadId = pathname.startsWith('/t/') ? threadId : null;
  const simpleChatThreads = useQuery({
    queryKey: simpleChatThreadsQueryKey,
    queryFn: listSimpleChatThreads,
    enabled: pathname.startsWith('/simple-chat'),
  });
  const simpleChatTitle = simpleChatThreads.data?.threads.find(
    (thread) => thread.id === simpleChatThreadId,
  )?.title;

  const renameThread = useMutation({
    ...threadsSetThreadNameMutation(),
    onSuccess: (_res, variables) => {
      setThreadTitle(variables.body.name.trim());
      setEditing(false);
      void queryClient.invalidateQueries({
        queryKey: threadsListThreadsQueryKey(),
      });
    },
  });

  const startEditing = () => {
    setDraftName(threadTitle ?? '');
    setEditing(true);
  };

  const saveName = () => {
    if (!threadId) return;
    const name = draftName.trim();
    if (!name) return;
    renameThread.mutate({ path: { threadId }, body: { name } });
  };

  // One label drives the accessible name and the tooltip, so they can never
  // disagree about which direction the control goes.
  const sidebarToggleLabel = desktopSidebarCollapsed
    ? t('expandSidebar')
    : t('collapseSidebar');

  const handleLogout = async () => {
    await disconnectPushOnLogout();
    await authLogout({ throwOnError: false }).catch(() => undefined);
    clearApiToken();
    resetSocket();
    setAccountOpen(false);
    void navigate({ to: '/login', search: { redirect: '/', manual: true } });
  };

  return (
    <>
      <header
        className={`glass-bar sticky top-0 z-10 flex shrink-0 items-center gap-2 px-3 sm:gap-3 sm:px-4 ${
          pathname === '/settings' ? 'h-14' : 'h-11'
        }`}
      >
        {/* Hamburger (mobile/tablet) or the desktop collapse toggle.
            The desktop toggle renders in both states from this one slot:
            collapsing used to live at the sidebar's bottom edge while only
            expanding lived here, so a single command moved and changed shape
            depending on state. Keeping one button element across both states
            also keeps focus on it after toggling. */}
        {!isDesktop ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0 lg:hidden"
            onClick={toggleSidebarOpen}
            aria-label={t('openNavigation')}
          >
            <Menu className="h-5 w-5" />
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                onClick={toggleDesktopSidebarCollapsed}
                aria-label={sidebarToggleLabel}
                aria-expanded={!desktopSidebarCollapsed}
                aria-controls={SIDEBAR_REGION_ID}
              >
                {desktopSidebarCollapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{sidebarToggleLabel}</TooltipContent>
          </Tooltip>
        )}

        <div className="min-w-0 flex-1">
          {visibleThreadId ? (
            <div className="flex min-w-0 items-center gap-2">
              {editing ? (
                <>
                  <Input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveName();
                      if (event.key === 'Escape') setEditing(false);
                    }}
                    className="h-8 max-w-sm"
                    autoFocus
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={saveName}
                    disabled={!draftName.trim()}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setEditing(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="truncate text-left text-sm font-semibold tracking-tight hover:underline"
                    onClick={startEditing}
                    title={threadTitle ?? visibleThreadId}
                  >
                    {threadTitle || visibleThreadId.slice(0, 8)}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={startEditing}
                    title={t('rename')}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </Button>
                  {isTracked && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setGraphOpen(true)}
                          aria-label={t('branchGraph')}
                        >
                          <Network className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('branchGraph')}</TooltipContent>
                    </Tooltip>
                  )}
                  {threadMode === 'readOnly' && (
                    <Badge variant="secondary" className="text-xs">
                      {t('readOnly')}
                    </Badge>
                  )}
                </>
              )}
            </div>
          ) : resourceRoute ? (
            <ProjectResourceHeader
              projectId={resourceRoute[1]}
              resourceId={resourceRoute[2]}
            />
          ) : projectRoute ? (
            <ProjectHeader projectId={projectRoute[1]} />
          ) : pathname === '/settings' ? (
            <div className="min-w-0 leading-tight">
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
                {t(translationKey(settingsPageLabel(settingsSection)))}
              </h1>
              <p className="truncate text-[11px] text-muted-foreground sm:text-xs">
                {t(translationKey(settingsPageDescription(settingsSection)))}
              </p>
            </div>
          ) : simpleChatTitle ? (
            <h1
              className="truncate text-sm font-semibold tracking-tight"
              title={simpleChatTitle}
            >
              {simpleChatTitle}
            </h1>
          ) : (
            <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              {pathname !== '/help' && (
                <BrandIcon className="h-7 w-7 shrink-0" />
              )}
              {pathname === '/help' ? t('platformGuide') : 'Mergeron'}
            </h1>
          )}
        </div>
        {/* Always visible badges */}
        <McpStatusBadge mode="header" />
        <span className="hidden sm:inline-flex">
          <AccountRateLimitBadge />
        </span>
        <Badge
          variant={connected ? 'default' : 'secondary'}
          className="text-xs transition-colors duration-300"
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full sm:mr-1.5 ${
              connected ? 'animate-pulse bg-green-400' : 'bg-muted-foreground'
            }`}
          />
          <span className="hidden sm:inline">
            {connected ? t('connected') : t('disconnected')}
          </span>
        </Badge>

        {/* Desktop: inline action buttons */}
        {isDesktop ? (
          <>
            {isAdministrator && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => void navigate({ to: '/settings' })}
                    aria-label={t('platformSettings')}
                  >
                    <MonitorCog className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('platformSettings')}</TooltipContent>
              </Tooltip>
            )}
          </>
        ) : isAdministrator ? (
          /* Mobile/Tablet: overflow menu popover */
          <MobileOverflowMenu
            onSettings={() => void navigate({ to: '/settings' })}
            t={t}
          />
        ) : null}
        <ReloadApplicationButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              onClick={() => setAccountOpen(true)}
              aria-label={t('account')}
            >
              <UserRound className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('account')}</TooltipContent>
        </Tooltip>
      </header>
      <Separator />
      <BranchGraphDialog
        threadId={graphOpen ? threadId : null}
        onClose={() => setGraphOpen(false)}
      />
      <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('myAccount')}</DialogTitle>
            <DialogDescription>
              {t('informationAboutTheIdentityCurrentlyConnected')}
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('fullName')}</dt>
              <dd className="mt-1 font-medium">
                {session.data?.name || t('unlinkedIdentity')}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('email')}</dt>
              <dd className="mt-1 break-all font-medium">
                {session.data?.email || '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('platformRole')}</dt>
              <dd className="mt-1 font-medium">
                {session.data?.role === 'administrator'
                  ? t('administrator')
                  : session.data?.role === 'standard'
                    ? t('standard')
                    : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('accountStatus')}</dt>
              <dd className="mt-1 font-medium">
                {session.data?.active ? t('active') : t('inactive')}
              </dd>
            </div>
          </dl>
          <ProfileAppearance />
          <PushNotificationSettings />
          <PwaInstall />
          <DialogFooter className="sm:justify-between">
            <Button variant="destructive" onClick={() => void handleLogout()}>
              <LogOut className="h-4 w-4" />
              {t('logout')}
            </Button>
            <Button variant="secondary" onClick={() => setAccountOpen(false)}>
              {t('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
