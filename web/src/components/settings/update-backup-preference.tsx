import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { translationKey } from '@/locales/translation-key';
import { backupDescription } from './manager-backup-policy';
import { useUpdateBackupMode } from './use-update-backup-mode';
import type { ManagerStatus } from './manager-status-api';

export function UpdateBackupPreference({
  status,
  busy = false,
  preference,
  onChange,
}: {
  status: ManagerStatus;
  busy?: boolean;
  preference?: ReturnType<typeof useUpdateBackupMode>;
  onChange?: () => void;
}) {
  const { t } = useTranslation('manager');
  const { t: common } = useTranslation();
  const backupSelection = status.capabilities?.backupSelection === true;
  const localPreference = useUpdateBackupMode(backupSelection && !preference);
  const backupPreference = preference ?? localPreference;
  const backupMode = backupPreference.value;
  const blocked = !status.available;
  return (
    <section className="rounded-lg border border-border p-4">
      {' '}
      {backupSelection && (
        <div className="space-y-2">
          <label htmlFor="manager-backup-mode" className="text-sm">
            {t('managerBackupMode')}
          </label>
          <select
            id="manager-backup-mode"
            aria-describedby="manager-backup-mode-help"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={backupMode}
            disabled={
              busy ||
              blocked ||
              !backupPreference.ready ||
              backupPreference.saving
            }
            onChange={(event) => {
              backupPreference.setValue(
                event.target.value as typeof backupMode,
              );
              onChange?.();
            }}
          >
            <option value="full">{t('managerFullBackup')}</option>
            <option value="minimal">{t('managerMinimalBackup')}</option>
            <option value="none">{t('managerNoBackup')}</option>
          </select>
          <p
            id="manager-backup-mode-help"
            className={
              backupMode === 'none'
                ? 'text-sm text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {t(translationKey(backupDescription(`${backupMode}-v1`)))}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('managerBackupPreferenceHelp')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                busy ||
                blocked ||
                !backupPreference.ready ||
                !backupPreference.dirty ||
                backupPreference.saving
              }
              onClick={backupPreference.save}
            >
              {t(
                backupPreference.saving
                  ? 'managerBackupPreferenceSaving'
                  : 'managerBackupPreferenceSave',
              )}
            </Button>
            {(backupPreference.loading ||
              backupPreference.saved ||
              backupPreference.dirty) && (
              <p role="status" className="text-xs text-muted-foreground">
                {t(
                  backupPreference.loading
                    ? 'managerBackupPreferenceLoading'
                    : backupPreference.dirty
                      ? 'managerBackupPreferenceUnsaved'
                      : 'managerBackupPreferenceSaved',
                )}
              </p>
            )}
            {backupPreference.readError && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={backupPreference.retry}
              >
                {common('retry')}
              </Button>
            )}
          </div>
          {(backupPreference.readError || backupPreference.saveError) && (
            <p role="alert" className="text-sm text-destructive">
              {t(
                backupPreference.readError
                  ? 'managerBackupPreferenceReadError'
                  : 'managerBackupPreferenceSaveError',
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
