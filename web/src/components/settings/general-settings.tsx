/** Server-wide runtime settings. */
import { useTranslation } from 'react-i18next';
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
  const runtimeSettings = useCategorySettings('general', {
    excludeKeys: EXCLUDED_RUNTIME_SETTINGS,
  });

  return (
    <section className="space-y-4">
      <ServerVersionCard />
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
    </section>
  );
}
