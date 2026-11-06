import { useTranslation } from 'react-i18next';
import { SettingEditor } from './setting-editor';
import { SettingsSaveBar } from './settings-save-bar';
import { useCategorySettings } from './use-category-settings';

const KEYS = {
  connections: ['general.maxIdleSubscriptions'],
  applications: ['general.applicationCatalogSource'],
} as const;

/** Explicit ownership prevents unrelated general settings leaking into these pages. */
export function RuntimePlacementSettings({
  kind,
}: {
  kind: keyof typeof KEYS;
}) {
  const { t } = useTranslation();
  const state = useCategorySettings('general', { includeKeys: KEYS[kind] });
  const applications = kind === 'applications';
  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        {t(
          applications
            ? 'applicationCatalogAdvanced'
            : 'connectionsPerformance',
        )}
      </h2>
      {state.isLoading && <p role="status">{t('loading')}</p>}
      {state.settings.map((setting) =>
        applications ? (
          <div key={setting.key} className="space-y-2 rounded-lg border p-4">
            <label
              className="block text-sm font-medium"
              htmlFor="application-catalog-source"
            >
              {t('applicationCatalogSourceLabel')}
            </label>
            <p
              id="application-catalog-help"
              className="text-xs text-muted-foreground"
            >
              {t('applicationCatalogSourceHelp')}
            </p>
            <select
              id="application-catalog-source"
              aria-describedby="application-catalog-help"
              value={state.drafts[setting.key]}
              disabled={state.isSaving}
              onChange={(event) =>
                state.handleDraftChange(setting.key, event.target.value)
              }
              className="rounded border bg-background p-2 text-sm"
            >
              <option value="native">Native</option>
              <option value="byparr">Byparr</option>
            </select>
            <button
              type="button"
              disabled={state.isSaving || setting.source !== 'db'}
              onClick={() => state.handleReset(setting.key)}
              className="ml-3 text-sm underline"
            >
              {t('reset')}
            </button>
          </div>
        ) : (
          <SettingEditor
            key={setting.key}
            setting={{ ...setting, description: t('idleConversationsHelp') }}
            draft={state.drafts[setting.key] ?? ''}
            disabled={state.isSaving}
            onDraftChange={state.handleDraftChange}
            onReset={state.handleReset}
          />
        ),
      )}
      <SettingsSaveBar
        hideWhenClean
        dirty={state.isDirty}
        saving={state.isSaving}
        onSave={() => void state.handleSaveAll()}
        onDiscard={state.discardChanges}
      />
    </section>
  );
}
