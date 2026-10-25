/** Server-wide runtime settings. */
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { BadgeInfo, Download, Archive, Plug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SettingEditor } from './setting-editor';
import { SettingsSaveBar } from './settings-save-bar';
import { useCategorySettings } from './use-category-settings';
import { ONLYOFFICE_SETTING_KEYS } from './settings-sections';
import { ServerVersionCard } from './server-version-card';

// Retention is edited exclusively through the structured dialog on the Logs page.
const EXCLUDED_RUNTIME_SETTINGS = [
  ...ONLYOFFICE_SETTING_KEYS,
  'general.logRetention',
] as const;

export function GeneralSettings() {
  const { t } = useTranslation();
  const { t: tm } = useTranslation('manager');
  const [tab, setTab] = useState<'current' | 'update' | 'backups' | 'socket'>(
    'current',
  );
  const runtimeSettings = useCategorySettings('general', {
    excludeKeys: EXCLUDED_RUNTIME_SETTINGS,
  });

  return (
    <section className="space-y-4">
      <div
        role="tablist"
        aria-label={tm('serverSettingsTabs')}
        className="flex overflow-x-auto border-b border-border"
        onKeyDown={(event) => {
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key))
            return;
          const tabs = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            ),
          ];
          const current = tabs.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (current +
                    (event.key === 'ArrowRight' ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
          event.preventDefault();
          tabs[next]?.focus();
          tabs[next]?.click();
        }}
      >
        {(
          [
            ['current', 'serverCurrentVersionTab', BadgeInfo],
            ['update', 'serverUpdateTab', Download],
            ['backups', 'serverBackupTab', Archive],
            ['socket', 'serverSocketTab', Plug],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            id={`server-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`server-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={cn(
              'flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
            {tm(label)}
          </button>
        ))}
      </div>
      {/* Keep update controls mounted so changing tabs cannot reset a plan or its progress dialog. */}
      <div
        hidden={tab === 'socket'}
        role={tab === 'socket' ? undefined : 'tabpanel'}
        id={tab === 'socket' ? undefined : `server-panel-${tab}`}
        aria-labelledby={tab === 'socket' ? undefined : `server-tab-${tab}`}
      >
        <ServerVersionCard view={tab === 'socket' ? 'current' : tab} />
      </div>
      <div
        hidden={tab !== 'socket'}
        role="tabpanel"
        id="server-panel-socket"
        aria-labelledby="server-tab-socket"
        className="space-y-4"
      >
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t('runtimeSettings')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t(
              'idleThreadSubscriptionsAreCleanedUpInTheBrowserWhileActiveOrApprovalBlockedThre9ac3fe67',
            )}
          </p>
        </div>

        {runtimeSettings.isLoading && (
          <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
            {t('loadingb04ba49f')}
          </div>
        )}

        {runtimeSettings.settings.map((setting) => (
          <SettingEditor
            key={setting.key}
            setting={setting}
            draft={runtimeSettings.drafts[setting.key] ?? ''}
            disabled={runtimeSettings.isSaving}
            onDraftChange={runtimeSettings.handleDraftChange}
            onReset={runtimeSettings.handleReset}
          />
        ))}
        <SettingsSaveBar
          hideWhenClean
          label="saveRuntimeSettings"
          dirty={runtimeSettings.isDirty}
          saving={runtimeSettings.isSaving}
          onSave={() => void runtimeSettings.handleSaveAll()}
          onDiscard={runtimeSettings.discardChanges}
        />
      </div>
    </section>
  );
}
