import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
  const [settings, setSettings] = useState(
    project.browserSettings ?? DEFAULT_BROWSER_SETTINGS,
  );
  const save = useMutation({
    mutationFn: () =>
      projectsApi(`/${project.id}/browser-settings`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: projectsQueryKey }),
  });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="font-semibold">{t('projectSettings')}</h2>
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
      <Button type="submit" disabled={save.isPending}>
        {t('saveSettings')}
      </Button>
    </form>
  );
}
