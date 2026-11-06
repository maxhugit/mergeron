import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IntegrationNav } from './integration-nav';
const PluginsTab = lazy(() =>
  import('./plugins-tab').then((m) => ({ default: m.PluginsTab })),
);
const AppsTab = lazy(() =>
  import('./apps-tab').then((m) => ({ default: m.AppsTab })),
);
const McpsTab = lazy(() =>
  import('./mcps-tab').then((m) => ({ default: m.McpsTab })),
);
const AdvancedSettings = lazy(() =>
  import('../settings/runtime-placement-settings').then((m) => ({
    default: () => <m.RuntimePlacementSettings kind="applications" />,
  })),
);
export type IntegrationSection = 'plugins' | 'apps' | 'mcps' | 'advanced';

/** One integration surface, mounted only while its Codex tab is visible. */
export function IntegrationsPanel({
  initialSection = 'plugins',
}: {
  initialSection?: IntegrationSection;
}) {
  const { t } = useTranslation('integrations');
  const { t: tRuntime } = useTranslation('runtimeSettings');
  const [section, setSection] = useState(initialSection);
  const [advancedVisited, setAdvancedVisited] = useState(
    initialSection === 'advanced',
  );
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card/40 px-4 pb-4">
      <IntegrationNav
        label={t('navigation')}
        value={section}
        onChange={(next) => {
          if (next === 'advanced') setAdvancedVisited(true);
          setSection(next);
        }}
        items={[
          {
            value: 'plugins',
            label: t('plugins'),
            description: t('pluginsDefinition'),
          },
          {
            value: 'apps',
            label: t('applications'),
            description: t('applicationsDefinition'),
          },
          {
            value: 'mcps',
            label: t('mcpServers'),
            description: t('mcpDefinition'),
          },
          {
            value: 'advanced',
            label: tRuntime('advancedSettings'),
          },
        ]}
      />
      <div
        className="flex min-h-0 flex-1 flex-col"
        role="tabpanel"
        aria-label={
          section === 'advanced'
            ? tRuntime('advancedSettings')
            : t(
                section === 'apps'
                  ? 'applications'
                  : section === 'mcps'
                    ? 'mcpServers'
                    : 'plugins',
              )
        }
      >
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {t('loading')}
            </p>
          }
        >
          {section === 'plugins' && <PluginsTab />}
          {section === 'apps' && <AppsTab />}
          {section === 'mcps' && <McpsTab />}
          {/* Preserve the unsaved draft when switching integration tabs. */}
          {advancedVisited && (
            <div
              hidden={section !== 'advanced'}
              className="min-h-0 overflow-y-auto"
            >
              <AdvancedSettings />
            </div>
          )}
        </Suspense>
      </div>
    </section>
  );
}
