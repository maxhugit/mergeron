import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { projectsApi } from '@/lib/projects-api';
import type { PreviewProfile } from '../../../../runtime/preview-profile.cjs';
import type { PreviewStorageLimits } from '../../../../runtime/preview-storage.cjs';
import { PreviewStorageSummary } from './preview-storage-summary';

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
  return (
    <section
      className="min-w-0 max-w-full space-y-4 [&_label]:min-w-0 [&_label]:grid-cols-1 [&_input]:min-w-0 [&_input]:max-w-full [&_select]:min-w-0 [&_select]:w-full [&_select]:max-w-full [&_textarea]:min-w-0 [&_textarea]:w-full [&_textarea]:max-w-full"
      aria-label={t('settingsTitle')}
    >
      <h2 className="font-semibold">{t('settingsTitle')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('settingsDescription')}
      </p>
      {(!data.capabilities.enabled || !data.viewer.enabled) && (
        <p
          role="status"
          className="rounded border border-amber-500 p-3 text-sm"
        >
          {t('setupRequired')}
        </p>
      )}
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
      {data.capabilities.storage && (
        <PreviewStorageSummary limits={data.capabilities.storage} />
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={profile.agentManaged ?? false}
          onChange={(e) => field('agentManaged', e.target.checked)}
        />
        {t('agentManaged')}
      </label>
      <p className="text-sm text-muted-foreground">{t('agentManagedHelp')}</p>
      {profile.agentManaged && (
        <fieldset className="min-w-0 space-y-2 rounded border p-3">
          <legend className="px-1 text-sm">{t('agentRuntimes')}</legend>
          {data.capabilities.runtimes.map((runtime) => (
            <label className="flex items-center gap-2 text-sm" key={runtime.id}>
              <input
                type="checkbox"
                checked={(profile.agentRuntimes ?? [profile.runtime]).includes(
                  runtime.id,
                )}
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
                    <option value={profile.runtime}>{profile.runtime}</option>
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
        <label className="grid gap-1 text-sm">
          {t('lifetime')}
          <input
            type="number"
            min={5}
            max={240}
            className="rounded border bg-background p-2"
            value={profile.lifetimeMinutes}
            onChange={(e) => field('lifetimeMinutes', Number(e.target.value))}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t('memory')}
          <input
            type="number"
            min={128}
            max={4096}
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
      <p className="text-xs text-muted-foreground">{t('hotHelp')}</p>
      {!profile.agentManaged && (
        <details className="space-y-3 rounded border p-3">
          <summary>{t('advanced')}</summary>
          <label className="grid gap-1 text-sm">
            {t('environment')}
            <textarea
              className="min-h-28 rounded border bg-background p-2 font-mono text-xs"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t('secretsHelp')}</p>
          <label className="grid gap-1 text-sm">
            {t('services')}
            <textarea
              className="min-h-28 rounded border bg-background p-2 font-mono text-xs"
              value={services}
              onChange={(e) => setServices(e.target.value)}
              spellCheck={false}
            />
          </label>
        </details>
      )}
      <p className="text-xs text-muted-foreground">{t('isolationHelp')}</p>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof Error ? save.error.message : t('saveFailed')}
        </p>
      )}
      {save.isSuccess && <p role="status">{t('saved')}</p>}
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? t('saving') : t('save')}
      </Button>
    </section>
  );
}
