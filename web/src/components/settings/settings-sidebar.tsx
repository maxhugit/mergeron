import { translationKey } from '@/locales/translation-key';
import {
  Activity,
  ArrowLeft,
  Bot,
  Database,
  FolderCog,
  FolderOpen,
  FileText,
  MessageCircle,
  PackageOpen,
  ScrollText,
  Plug,
  ServerCog,
  Network,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  UserCircle,
  UsersRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useLayoutStore } from '@/stores/layout-store';
import { cn } from '@/lib/utils';
import { settingsPageLabel } from './setting-helpers';
import { requestCli, type CliStatus } from './codex-cli-api';
import { serverReleaseQueryOptions } from './server-release-api';

import { SETTINGS_SECTIONS } from './settings-sections';

const sectionIcons = {
  general: ServerCog,
  infrastructure: Network,
  onlyOffice: FileText,
  people: UsersRound,
  account: UserCircle,
  codex: Bot,
  codexCli: PackageOpen,
  simpleChat: MessageCircle,
  terminal: SquareTerminal,
  files: FolderCog,
  database: Database,
  security: ShieldCheck,
  integrations: Plug,
} satisfies Record<(typeof SETTINGS_SECTIONS)[number], typeof ServerCog>;

function ServerUpdateIndicator() {
  const { t } = useTranslation('manager');
  const query = useQuery(serverReleaseQueryOptions);
  if (!query.data?.updateAvailable || query.isError || query.data.checkError)
    return null;
  return (
    <span
      role="status"
      aria-label={t('managerNewImageAvailable')}
      title={t('managerNewImageAvailable')}
      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-semibold text-white"
    >
      !
    </span>
  );
}

function CodexCliUpdateIndicator() {
  const { t } = useTranslation();
  const [state, setState] = useState<'current' | 'update' | 'missing'>(
    'current',
  );
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void requestCli<CliStatus>()
        .then((status) => {
          if (active)
            setState(
              status.installationState === 'missing'
                ? 'missing'
                : status.updateAvailable
                  ? 'update'
                  : 'current',
            );
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  if (state === 'current') return null;
  return (
    <span
      aria-hidden="true"
      title={t(
        state === 'missing'
          ? 'codexCliInstallationIsRequired'
          : 'aCliUpdateIsAvailable',
      )}
      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-semibold text-white"
    >
      !
    </span>
  );
}

/** Administration navigation, shared by desktop and mobile drawers.
 * This is a navigation boundary, not an authorization boundary. The current
 * server session is shared; per-person roles must be enforced server-side.
 */
export function SettingsSidebar() {
  const { t } = useTranslation(['common', 'manager'], { nsMode: 'fallback' });
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = useRouterState({
    select: (s) =>
      (s.location.search as { section?: string }).section ?? 'general',
  });
  const close = useLayoutStore((s) => s.setSidebarOpen);
  const itemClass = (selected: boolean) =>
    cn(
      'flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
      selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
    );
  return (
    <nav
      aria-label={t('administrationNavigation')}
      className="flex h-full min-h-0 flex-col bg-card/80"
    >
      <div className="shrink-0 border-b p-2">
        <button
          className={itemClass(false)}
          onClick={() => {
            close(false);
            void navigate({ to: '/' });
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('backToProjects')}
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-4">
        <section>
          <h2 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('administration')}
          </h2>
          {SETTINGS_SECTIONS.filter((entry) => entry !== 'account').map(
            (entry) => {
              const Icon = sectionIcons[entry];
              return (
                <button
                  key={entry}
                  aria-current={
                    pathname === '/settings' && section === entry
                      ? 'page'
                      : undefined
                  }
                  className={itemClass(
                    pathname === '/settings' && section === entry,
                  )}
                  onClick={() => {
                    close(false);
                    void navigate({
                      to: '/settings',
                      search: { section: entry },
                    });
                  }}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {t(translationKey(settingsPageLabel(entry)))}
                  {entry === 'general' && <ServerUpdateIndicator />}
                  {entry === 'codexCli' && <CodexCliUpdateIndicator />}
                </button>
              );
            },
          )}
        </section>
        <section>
          <h2 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('operationsTools')}
          </h2>
          <button
            aria-current={pathname === '/files' ? 'page' : undefined}
            className={itemClass(pathname === '/files')}
            onClick={() => {
              close(false);
              void navigate({ to: '/files' });
            }}
          >
            <FolderOpen className="h-4 w-4" />
            {t('files')}
          </button>
          <button
            aria-current={pathname === '/terminal' ? 'page' : undefined}
            className={itemClass(pathname === '/terminal')}
            onClick={() => {
              close(false);
              void navigate({ to: '/terminal' });
            }}
          >
            <Terminal className="h-4 w-4" />
            {t('terminal')}
          </button>
          <button
            aria-current={pathname === '/logs' ? 'page' : undefined}
            className={itemClass(pathname === '/logs')}
            onClick={() => {
              close(false);
              void navigate({ to: '/logs' });
            }}
          >
            <ScrollText className="h-4 w-4" />
            {t('logs')}
          </button>
          <button
            aria-current={pathname === '/diagnostics' ? 'page' : undefined}
            className={itemClass(pathname === '/diagnostics')}
            onClick={() => {
              close(false);
              void navigate({ to: '/diagnostics' });
            }}
          >
            <Activity className="h-4 w-4" />
            {t('diagnostics')}
          </button>
        </section>
      </div>
    </nav>
  );
}
