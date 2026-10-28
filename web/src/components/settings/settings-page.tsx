/**
 * Settings page shell with tab routing to category sub-components.
 */
import { lazy, Suspense, useId, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Blocks, PackageOpen, Plug } from 'lucide-react';
import type { SettingsSection } from './settings-sections';
import { cn } from '@/lib/utils';
import { translationKey } from '@/locales/translation-key';

const integrationTabs = [
  { id: 'plugins', label: 'plugins', Icon: Blocks },
  { id: 'apps', label: 'apps', Icon: PackageOpen },
  { id: 'mcps', label: 'mcpServers', Icon: Plug },
] as const;
type IntegrationSection = (typeof integrationTabs)[number]['id'];

const GeneralSettings = lazy(() =>
  import('./general-settings').then((module) => ({
    default: module.GeneralSettings,
  })),
);
const InternalMcpSettings = lazy(() =>
  import('./internal-mcp-settings').then((module) => ({
    default: module.InternalMcpSettings,
  })),
);
const InfrastructureSettings = lazy(() =>
  import('./infrastructure-settings').then((module) => ({
    default: module.InfrastructureSettings,
  })),
);
const OnlyOfficeSettings = lazy(() =>
  import('./onlyoffice-settings').then((module) => ({
    default: module.OnlyOfficeSettings,
  })),
);
const CodexSettings = lazy(() =>
  import('./codex-settings').then((module) => ({
    default: module.CodexSettings,
  })),
);
const TerminalSettings = lazy(() =>
  import('./terminal-settings').then((module) => ({
    default: module.TerminalSettings,
  })),
);
const FilesSettings = lazy(() =>
  import('./files-settings').then((module) => ({
    default: module.FilesSettings,
  })),
);
const SecuritySettings = lazy(() =>
  import('./security-settings').then((module) => ({
    default: module.SecuritySettings,
  })),
);
const PluginsTab = lazy(() =>
  import('@/components/integrations/plugins-tab').then((module) => ({
    default: module.PluginsTab,
  })),
);
const AppsTab = lazy(() =>
  import('@/components/integrations/apps-tab').then((module) => ({
    default: module.AppsTab,
  })),
);
const McpsTab = lazy(() =>
  import('@/components/integrations/mcps-tab').then((module) => ({
    default: module.McpsTab,
  })),
);
const PeopleManager = lazy(() =>
  import('@/components/projects/people-manager').then((module) => ({
    default: module.PeopleManager,
  })),
);
const DatabaseSettings = lazy(() =>
  import('./database-settings').then((module) => ({
    default: module.DatabaseSettings,
  })),
);

export function SettingsPage() {
  const { t } = useTranslation();
  const section = useRouterState({
    select: (s) =>
      (s.location.search as { section?: SettingsSection }).section ?? 'general',
  });
  const [integrationSection, setIntegrationSection] =
    useState<IntegrationSection>('plugins');
  const integrationPanelId = useId();
  const usesFullHeightLayout = [
    'database',
    'codex',
    'account',
    'codexCli',
    'general',
  ].includes(section);

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        usesFullHeightLayout ? 'overflow-hidden' : 'overflow-auto',
      )}
    >
      <div
        className={cn(
          'mx-auto w-full',
          usesFullHeightLayout
            ? 'flex min-h-0 flex-1 flex-col'
            : cn(
                'space-y-6 px-4 py-4 sm:px-6',
                !['infrastructure', 'people'].includes(section) && 'max-w-4xl',
              ),
        )}
      >
        <Suspense
          fallback={
            <div className="p-6 text-sm text-muted-foreground" role="status">
              {t('loading')}
            </div>
          }
        >
          {section === 'general' && <GeneralSettings />}
          {section === 'internalMcp' && <InternalMcpSettings />}
          {section === 'infrastructure' && <InfrastructureSettings />}
          {section === 'onlyOffice' && <OnlyOfficeSettings />}
          {section === 'people' && <PeopleManager showHeading={false} />}
          {(section === 'codex' ||
            section === 'account' ||
            section === 'codexCli' ||
            section === 'simpleChat') && (
            <CodexSettings
              key={section}
              initialTab={
                section === 'codexCli'
                  ? 'cli'
                  : section === 'simpleChat'
                    ? 'chatAudio'
                    : 'account'
              }
            />
          )}
          {section === 'terminal' && <TerminalSettings />}
          {section === 'files' && <FilesSettings />}
          {section === 'database' && <DatabaseSettings />}
          {section === 'security' && <SecuritySettings />}
          {section === 'integrations' && (
            <div>
              <div className="flex h-10 min-w-0 items-center border-b bg-background">
                <div
                  role="tablist"
                  aria-label={t('integrations')}
                  className="flex min-w-0 flex-1 items-center overflow-x-auto"
                  onKeyDown={(event) => {
                    if (
                      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                        event.key,
                      )
                    )
                      return;
                    const tabs = [
                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      ),
                    ];
                    const current = tabs.indexOf(
                      document.activeElement as HTMLButtonElement,
                    );
                    const index =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : (current +
                              (event.key === 'ArrowRight' ? 1 : -1) +
                              tabs.length) %
                            tabs.length;
                    event.preventDefault();
                    tabs[index]?.focus();
                    tabs[index]?.click();
                  }}
                >
                  {integrationTabs.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      id={`${integrationPanelId}-${id}`}
                      type="button"
                      role="tab"
                      aria-selected={integrationSection === id}
                      aria-controls={integrationPanelId}
                      tabIndex={integrationSection === id ? 0 : -1}
                      onClick={() => setIntegrationSection(id)}
                      className={cn(
                        'flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]',
                        integrationSection === id
                          ? 'border-primary text-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4" />
                      <span>{t(translationKey(label))}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div
                id={integrationPanelId}
                role="tabpanel"
                aria-labelledby={`${integrationPanelId}-${integrationSection}`}
                className="pt-6"
              >
                {integrationSection === 'plugins' && <PluginsTab />}
                {integrationSection === 'apps' && <AppsTab />}
                {integrationSection === 'mcps' && <McpsTab />}
              </div>
            </div>
          )}
        </Suspense>
      </div>
    </div>
  );
}
