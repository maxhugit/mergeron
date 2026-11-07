import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  SettingsPanel,
  SettingsPanelActions,
} from '@/components/settings/settings-panel';
import { Switch } from '@/components/ui/switch';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';

const DEFAULT_BROWSER_SETTINGS = {
  homeUrl: 'https://www.google.com',
  desktopSplit: true,
  allowPopups: true,
};

export function ProjectBrowserSettings({
  project,
}: {
  project: ProjectSummary;
}) {
  const { t } = useTranslation('browser');
  const client = useQueryClient();
  const formId = useId();
  const [baseline, setBaseline] = useState(
    project.browserSettings ?? DEFAULT_BROWSER_SETTINGS,
  );
  const [settings, setSettings] = useState(
    project.browserSettings ?? DEFAULT_BROWSER_SETTINGS,
  );
  const save = useMutation({
    mutationFn: (submitted: typeof settings) =>
      projectsApi(`/${project.id}/browser-settings`, {
        method: 'PATCH',
        body: JSON.stringify(submitted),
      }),
    onSuccess: async (_data, submitted) => {
      setBaseline(submitted);
      await client.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
  const dirty = JSON.stringify(settings) !== JSON.stringify(baseline);
  return (
    <form
      id={formId}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(settings);
      }}
    >
      <SettingsPanel
        heading={
          <>
            <h2 className="font-semibold">{t('projectSettings')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('settingsApplyNew')}
            </p>
          </>
        }
      >
        <label className="grid gap-2 text-sm">
          {t('homeUrl')}
          <input
            type="url"
            disabled={save.isPending}
            required
            maxLength={4096}
            className="h-9 rounded-md border bg-background px-3"
            value={settings.homeUrl}
            onChange={(event) =>
              setSettings({ ...settings, homeUrl: event.target.value })
            }
          />
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={settings.desktopSplit}
            disabled={save.isPending}
            onCheckedChange={(desktopSplit) =>
              setSettings({ ...settings, desktopSplit })
            }
          />
          {t('desktopSplitDefault')}
        </label>
        <p className="text-xs text-muted-foreground">{t('mobileFullWidth')}</p>
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={settings.allowPopups}
            disabled={save.isPending}
            onCheckedChange={(allowPopups) =>
              setSettings({ ...settings, allowPopups })
            }
          />
          {t('allowPopups')}
        </label>
        <p className="text-xs text-muted-foreground">{t('settingsApplyNew')}</p>
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('settingsFailed')}
          </p>
        )}
        {save.isSuccess && (
          <p role="status" className="text-sm">
            {t('settingsSaved')}
          </p>
        )}
        <SettingsPanelActions>
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setSettings(baseline);
              save.reset();
            }}
          >
            {t('cancel', { ns: 'common' })}
          </Button>
          <Button form={formId} type="submit" disabled={save.isPending}>
            {t('saveSettings')}
          </Button>
        </SettingsPanelActions>
      </SettingsPanel>
    </form>
  );
}
