/**
 * Settings page shell with tab routing to category sub-components.
 */
import { lazy, Suspense } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { SettingsSection } from './settings-sections';
import { cn } from '@/lib/utils';

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
  const usesFullHeightLayout = [
    'database',
    'codex',
    'account',
    'integrations',
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
            section === 'simpleChat' ||
            section === 'integrations') && (
            <CodexSettings
              key={section}
              initialTab={
                section === 'integrations'
                  ? 'integrations'
                  : section === 'codexCli'
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
        </Suspense>
      </div>
    </div>
  );
}
