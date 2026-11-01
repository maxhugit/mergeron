/**
 * TanStack Router configuration with code-based route tree.
 * Auth guard on the root layout redirects unauthenticated users to /login.
 */
import {
  createRouter,
  createRoute,
  createRootRoute,
  lazyRouteComponent,
  redirect,
  Outlet,
} from '@tanstack/react-router';
import { getApiToken } from '@/auth-token';
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from '@/components/settings/settings-sections';
import { BASE_PATH } from '@/base-path';

export type LoginSearch = {
  redirect: string;
  manual?: boolean;
  renew?: boolean;
};
export type IntegrationsSearch = { tab: 'plugins' | 'apps' | 'mcps' };
export type SimpleChatSearch = { thread?: string };

const INTEGRATION_TABS = ['plugins', 'apps', 'mcps'] as const;

// Route bodies are intentionally loaded on demand. Editors, document viewers,
// diagrams and administration screens are sizeable and are not needed for the
// application's initial shell.
const LoginRoute = lazyRouteComponent(
  () => import('./login-route'),
  'LoginRoute',
);
const AuthenticatedLayout = lazyRouteComponent(
  () => import('./authenticated-layout'),
  'AuthenticatedLayout',
);
const HomeRoute = lazyRouteComponent(() => import('./home-route'), 'HomeRoute');
const HelpRoute = lazyRouteComponent(() => import('./help-route'), 'HelpRoute');
const ThreadView = lazyRouteComponent(
  () => import('./thread-view'),
  'ThreadView',
);
const FilesRoute = lazyRouteComponent(
  () => import('./files-route'),
  'FilesRoute',
);
const DocumentRoute = lazyRouteComponent(
  () => import('./document-route'),
  'DocumentRoute',
);
const TerminalRoute = lazyRouteComponent(
  () => import('./terminal-route'),
  'TerminalRoute',
);
const DiagnosticsRoute = lazyRouteComponent(
  () => import('./diagnostics-route'),
  'DiagnosticsRoute',
);
const LogsRoute = lazyRouteComponent(() => import('./logs-route'), 'LogsRoute');
const SimpleChatRoute = lazyRouteComponent(
  () => import('./simple-chat-route'),
  'SimpleChatRoute',
);
const ProjectResourceRoute = lazyRouteComponent(
  () => import('./project-resource-route'),
  'ProjectResourceRoute',
);
const ProjectArchivesRoute = lazyRouteComponent(
  () => import('./project-archives-route'),
  'ProjectArchivesRoute',
);
const ProjectRoute = lazyRouteComponent(
  () => import('./project-route'),
  'ProjectRoute',
);
const SettingsPage = lazyRouteComponent(
  () => import('@/components/settings/settings-page'),
  'SettingsPage',
);
const IntegrationsPage = lazyRouteComponent(
  () => import('@/components/integrations/integrations-page'),
  'IntegrationsPage',
);

function sanitizeIntegrationsSearch(
  search: Record<string, unknown>,
): IntegrationsSearch {
  const tab = search.tab;
  return {
    tab: INTEGRATION_TABS.includes(tab as IntegrationsSearch['tab'])
      ? (tab as IntegrationsSearch['tab'])
      : 'plugins',
  };
}

/** Sanitizes redirect target to prevent open-redirect attacks. */
function sanitizeRedirect(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.startsWith('/api/')) return '/';
  return value;
}

/** Bare root — just renders child routes. */
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

/** Login route — remains reachable to switch authentication methods. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: sanitizeRedirect(search.redirect),
    manual: search.manual === true || search.manual === 'true',
    renew: search.renew === true || search.renew === 'true',
  }),
  component: LoginRoute,
});

/** Authenticated layout — sidebar + header + outlet. */
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  beforeLoad: ({ location }) => {
    if (!getApiToken()) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      });
    }
  },
  component: AuthenticatedLayout,
});

/** Index route — cross-project overview. */
const indexRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/',
  component: HomeRoute,
});

const helpRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/help',
  component: HelpRoute,
});

/** Thread route — specific thread by id. */
export const threadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/t/$threadId',
  component: ThreadView,
});

/** Global files view. */
const filesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/files',
  component: FilesRoute,
});

/** Standalone authenticated document tab. */
const documentRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/document',
  validateSearch: (search: Record<string, unknown>): { path?: string } => ({
    path:
      typeof search.path === 'string' &&
      search.path.startsWith('/') &&
      !search.path.includes('\0')
        ? search.path
        : undefined,
  }),
  component: DocumentRoute,
});

/** Global terminal view. */
const terminalRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/terminal',
  component: TerminalRoute,
});

/** Diagnostics panel. */
const diagnosticsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/diagnostics',
  component: DiagnosticsRoute,
});

/** Live structured application logs. */
const logsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/logs',
  component: LogsRoute,
});

/** General-purpose low-cost chat backed directly by the OpenAI API. */
export const simpleChatRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/simple-chat',
  validateSearch: (search: Record<string, unknown>): SimpleChatSearch => ({
    thread:
      typeof search.thread === 'string' && search.thread
        ? search.thread
        : undefined,
  }),
  component: SimpleChatRoute,
});

const projectResourceRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$projectId/resources/$resourceId',
  validateSearch: (
    search: Record<string, unknown>,
  ): { task?: string; deliverable?: string } => ({
    task:
      typeof search.task === 'string' && search.task ? search.task : undefined,
    deliverable:
      typeof search.deliverable === 'string' && search.deliverable
        ? search.deliverable
        : undefined,
  }),
  component: ProjectResourceRoute,
});

const projectRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$projectId',
  component: ProjectRoute,
});
const projectArchivesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$projectId/archives',
  component: ProjectArchivesRoute,
});

/** Settings page. */
const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/settings',
  validateSearch: (
    search: Record<string, unknown>,
  ): { section?: SettingsSection } => ({
    section: SETTINGS_SECTIONS.includes(search.section as SettingsSection)
      ? (search.section as SettingsSection)
      : undefined,
  }),
  component: SettingsPage,
});

/** Integrations page (plugins, apps, MCPs). */
const integrationsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/integrations',
  validateSearch: sanitizeIntegrationsSearch,
  component: IntegrationsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedRoute.addChildren([
    indexRoute,
    helpRoute,
    threadRoute,
    filesRoute,
    documentRoute,
    terminalRoute,
    diagnosticsRoute,
    logsRoute,
    simpleChatRoute,
    projectRoute,
    projectResourceRoute,
    projectArchivesRoute,
    settingsRoute,
    integrationsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  basepath: BASE_PATH || '/',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
