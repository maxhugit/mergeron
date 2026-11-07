import { translationKey } from '@/locales/translation-key';
/** Shared, mobile-safe action bar for one administration tab. */
import { useContext } from 'react';
import { SettingsPanelContext } from './settings-panel-context';
import { SettingsPanelActions } from './settings-panel';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLayoutStore } from '@/stores/layout-store';

export function SettingsSaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  label = 'Save',
  hideWhenClean = false,
  inline = false,
  active = true,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  label?: string;
  hideWhenClean?: boolean;
  inline?: boolean;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const desktopSidebarCollapsed = useLayoutStore(
    (state) => state.desktopSidebarCollapsed,
  );
  const panel = useContext(SettingsPanelContext);
  if (!active || (hideWhenClean && !dirty && !saving)) return null;
  const controls = (
    <div
      role="region"
      aria-label={t('saveSettings')}
      className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3"
    >
      <span role="status" className="mr-auto text-xs text-muted-foreground">
        {dirty ? t('unsavedChanges') : t('noPendingChanges')}
      </span>
      {onDiscard && (
        <Button
          variant="outline"
          disabled={!dirty || saving}
          onClick={onDiscard}
        >
          {t('cancel')}
        </Button>
      )}
      <Button disabled={!dirty || saving} onClick={onSave}>
        {saving ? t('saving') : t(translationKey(label))}
      </Button>
    </div>
  );
  if (inline) return controls;
  if (panel) return <SettingsPanelActions>{controls}</SettingsPanelActions>;
  return (
    <>
      <div className="h-24" aria-hidden="true" />
      <div
        role="region"
        aria-label={t('saveSettings')}
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur transition-[left] duration-200 ease-in-out',
          !desktopSidebarCollapsed && 'lg:left-64',
        )}
      >
        <div className="mx-auto flex max-w-4xl items-center justify-end gap-3">
          <span role="status" className="mr-auto text-xs text-muted-foreground">
            {dirty ? t('unsavedChanges') : t('noPendingChanges')}
          </span>
          {onDiscard && (
            <Button
              variant="outline"
              disabled={!dirty || saving}
              onClick={onDiscard}
            >
              {t('cancel')}
            </Button>
          )}
          <Button disabled={!dirty || saving} onClick={onSave}>
            {saving ? t('saving') : t(translationKey(label))}
          </Button>
        </div>
      </div>
    </>
  );
}
