import { useId, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { projectsApi } from '@/lib/projects-api';
import type { PreviewProfile } from '../../../../runtime/preview-profile.cjs';
import type { PreviewStorageLimits } from '../../../../runtime/preview-storage.cjs';
import { PreviewStorageSummary } from './preview-storage-summary';
import {
  SettingsPanel,
  SettingsPanelActions,
} from '@/components/settings/settings-panel';
import { ProjectPanelNavigation } from './project-panel-navigation';
import { PreviewLifetimeSelect } from './preview-lifetime-select';
import { PreparedPreviewRecipes } from './preview-recipe';
import { PreviewPrerequisites } from './preview-prerequisites';

interface Settings {
  profile: PreviewProfile;
  revision: string | null;
  capabilities: {
    enabled: boolean;
    domain: string | null;
    runtimes: { id: string; description: string }[];
    storage?: PreviewStorageLimits;
  };
  viewer: { enabled: boolean };
  prerequisites?: { available: boolean; missingConfiguration: string[] };
}
export function ProjectPreviewSettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation('previews');
  const query = useQuery({
    queryKey: ['preview-settings', projectId],
    queryFn: () => projectsApi<Settings>(`/${projectId}/test-environment`),
  });
  if (!query.data)
    return (
      <p role={query.isError ? 'alert' : undefined}>
        {query.isError ? t('unavailable') : t('loading')}
      </p>
    );
  return (
    <Editor
      key={query.data.revision ?? 'new'}
      projectId={projectId}
      data={query.data}
      refresh={() => {
        void query.refetch();
      }}
    />
  );
}
function Editor({
  projectId,
  data,
  refresh,
}: {
  projectId: string;
  data: Settings;
  refresh: () => void;
}) {
  const { t } = useTranslation('previews');
  const [profile, setProfile] = useState(data.profile);
  const panelId = useId();
  const [tab, setTab] = useState('execution');
  const [environment, setEnvironment] = useState(
    JSON.stringify(data.profile.env, null, 2),
  );
  const [services, setServices] = useState(
    JSON.stringify(data.profile.services, null, 2),
  );
  const save = useMutation({
    mutationFn: () =>
      projectsApi(`/${projectId}/test-environment`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedRevision: data.revision,
          profile: {
            ...profile,
            env: JSON.parse(environment),
            services: JSON.parse(services),
          },
        }),
      }),
    onSuccess: refresh,
  });
  const field = (key: keyof PreviewProfile, value: unknown) =>
    setProfile((p) => ({ ...p, [key]: value }));
  const dirty =
    JSON.stringify(profile) !== JSON.stringify(data.profile) ||
    environment !== JSON.stringify(data.profile.env, null, 2) ||
    services !== JSON.stringify(data.profile.services, null, 2);
  return (
    <SettingsPanel
      contentId={panelId}
      labelledBy={`${panelId}-${tab}`}
      navigation={
        <ProjectPanelNavigation
          namespace="previews"
          contentId={panelId}
          label={t('settingsTitle')}
          value={tab}
          onChange={setTab}
          items={[
            { id: 'execution', label: 'executionTab' },
            { id: 'resources', label: 'resourcesTab' },
            { id: 'advanced', label: 'advancedTab' },
          ]}
        />
      }
    >
      <section
        className="min-w-0 max-w-full space-y-4 [&_label]:min-w-0 [&_label]:grid-cols-1 [&_input]:min-w-0 [&_input]:max-w-full [&_select]:min-w-0 [&_select]:w-full [&_select]:max-w-full [&_textarea]:min-w-0 [&_textarea]:w-full [&_textarea]:max-w-full"
        aria-label={t('settingsTitle')}
      >
        <div hidden={tab !== 'execution'} className="space-y-4">
          <h2 className="font-semibold">{t('settingsTitle')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('settingsDescription')}
          </p>
          <PreviewPrerequisites
            reasons={
              data.prerequisites?.missingConfiguration ?? [
                ...(!data.capabilities.enabled
                  ? ['manager_not_configured']
                  : []),
                ...(!data.viewer.enabled ? ['viewer_not_ready'] : []),
              ]
            }
          />
          <p className="text-sm">
            {t('domain')}:{' '}
            {data.capabilities.domain
              ? `*.${data.capabilities.domain}`
              : t('notConfigured')}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={profile.enabled}
              onChange={(e) => field('enabled', e.target.checked)}
            />
            {t('enable')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={profile.agentManaged ?? false}
              onChange={(e) => field('agentManaged', e.target.checked)}
            />
            {t('agentManaged')}
          </label>
          <p className="text-sm text-muted-foreground">
            {t('agentManagedHelp')}
          </p>
          {profile.agentManaged && (
            <fieldset className="min-w-0 space-y-2 rounded border p-3">
              <legend className="px-1 text-sm">{t('agentRuntimes')}</legend>
              {!data.capabilities.runtimes.length && (
                <p className="text-sm text-muted-foreground">
                  {t('prerequisiteNoRuntimes')}
                </p>
              )}
              {data.capabilities.runtimes.map((runtime) => (
                <label
                  className="flex items-center gap-2 text-sm"
                  key={runtime.id}
                >
                  <input
                    type="checkbox"
                    checked={(
                      profile.agentRuntimes ?? [profile.runtime]
                    ).includes(runtime.id)}
                    onChange={(e) =>
                      field(
                        'agentRuntimes',
                        e.target.checked
                          ? [
                              ...(profile.agentRuntimes ?? [profile.runtime]),
                              runtime.id,
                            ]
                          : (profile.agentRuntimes ?? [profile.runtime]).filter(
                              (id) => id !== runtime.id,
                            ),
                      )
                    }
                  />
                  {runtime.description}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                {t('agentLimitsHelp')}
              </p>
            </fieldset>
          )}
          {profile.agentManaged && (
            <PreparedPreviewRecipes projectId={projectId} disabled={dirty} />
          )}
          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            {!profile.agentManaged && (
              <>
                <label className="grid gap-1 text-sm">
                  {t('runtime')}
                  {/* WebKit/GTK ignores overflow on native selects; bound their
              anonymous option content with a regular element instead. */}
                  <div className="relative min-w-0 overflow-hidden rounded border bg-background focus-within:ring-2 focus-within:ring-ring">
                    <select
                      className="block appearance-none bg-background p-2 pr-8 text-foreground"
                      value={profile.runtime}
                      onChange={(e) => field('runtime', e.target.value)}
                    >
                      {!data.capabilities.runtimes.some(
                        (v) => v.id === profile.runtime,
                      ) && (
                        <option value={profile.runtime}>
                          {profile.runtime}
                        </option>
                      )}
                      {data.capabilities.runtimes.map((v) => (
                        <option value={v.id} key={v.id}>
                          {v.description}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                  </div>
                </label>
                <label className="grid gap-1 text-sm">
                  {t('directory')}
                  <input
                    className="rounded border bg-background p-2"
                    value={profile.directory}
                    onChange={(e) => field('directory', e.target.value)}
                  />
                </label>
                {(['install', 'build', 'start'] as const).map((key) => (
                  <label className="grid gap-1 text-sm md:col-span-2" key={key}>
                    {
                      {
                        install: t('install'),
                        build: t('build'),
                        start: t('start'),
                      }[key]
                    }
                    <textarea
                      className="min-h-16 rounded border bg-background p-2 font-mono text-xs"
                      value={profile[key]}
                      onChange={(e) => field(key, e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                ))}
                <label className="grid gap-1 text-sm">
                  {t('port')}
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    className="rounded border bg-background p-2"
                    value={profile.port}
                    onChange={(e) => field('port', Number(e.target.value))}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {t('path')}
                  <input
                    className="rounded border bg-background p-2"
                    value={profile.path}
                    onChange={(e) => field('path', e.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {t('updateMode')}
                  <div className="relative min-w-0 overflow-hidden rounded border bg-background focus-within:ring-2 focus-within:ring-ring">
                    <select
                      className="block appearance-none bg-background p-2 pr-8 text-foreground"
                      value={profile.updateMode}
                      onChange={(e) => field('updateMode', e.target.value)}
                    >
                      <option value="hot">{t('hot')}</option>
                      <option value="restart">{t('restartMode')}</option>
                      <option value="manual">{t('manual')}</option>
                    </select>
                    <ChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                  </div>
                </label>
              </>
            )}
          </div>
        </div>
        <div hidden={tab !== 'resources'} className="space-y-4">
          <h3 className="font-semibold">{t('resourcesTab')}</h3>
          {data.capabilities.storage && (
            <PreviewStorageSummary limits={data.capabilities.storage} />
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <PreviewLifetimeSelect
              value={profile.lifetimeMinutes}
              onChange={(value) => field('lifetimeMinutes', value)}
            />
            <label className="grid gap-1 text-sm">
              {t('memory')}
              <input
                type="number"
                min={128}
                max={8192}
                className="rounded border bg-background p-2"
                value={profile.memoryMb}
                onChange={(e) => field('memoryMb', Number(e.target.value))}
              />
            </label>
            <label className="grid gap-1 text-sm">
              {t('cpus')}
              <input
                type="number"
                min={1}
                max={4}
                className="rounded border bg-background p-2"
                value={profile.cpus}
                onChange={(e) => field('cpus', Number(e.target.value))}
              />
            </label>
          </div>
        </div>
        <p
          hidden={tab !== 'execution'}
          className="text-xs text-muted-foreground"
        >
          {t('hotHelp')}
        </p>
        <div hidden={tab !== 'advanced'} className="space-y-4">
          {profile.agentManaged ? (
            <p className="text-sm text-muted-foreground">
              {t('agentLimitsHelp')}
            </p>
          ) : (
            <div className="space-y-3">
              <h3 className="font-semibold">{t('advanced')}</h3>
              <label className="grid gap-1 text-sm">
                {t('environment')}
                <textarea
                  className="min-h-28 rounded border bg-background p-2 font-mono text-xs"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {t('secretsHelp')}
              </p>
              <label className="grid gap-1 text-sm">
                {t('services')}
                <textarea
                  className="min-h-28 rounded border bg-background p-2 font-mono text-xs"
                  value={services}
                  onChange={(e) => setServices(e.target.value)}
                  spellCheck={false}
                />
              </label>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('isolationHelp')}</p>
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof Error ? save.error.message : t('saveFailed')}
          </p>
        )}
        {save.isSuccess && <p role="status">{t('saved')}</p>}
        <SettingsPanelActions>
          <Button
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setProfile(data.profile);
              setEnvironment(JSON.stringify(data.profile.env, null, 2));
              setServices(JSON.stringify(data.profile.services, null, 2));
              save.reset();
            }}
          >
            {t('cancel', { ns: 'common' })}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </SettingsPanelActions>
      </section>
    </SettingsPanel>
  );
}
