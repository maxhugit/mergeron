import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import type { PreviewProfile } from '../../../../runtime/preview-profile.cjs';

export interface LaunchConfiguration {
  profile: PreviewProfile | null;
  policyRevision: string;
  recipeRevision: string | null;
  revision: string | null;
  agentManaged: boolean;
  stale: boolean;
  sourcePath: string | null;
  sourceError?: string | null;
}
export function PreviewCommands({
  configuration,
}: {
  configuration: LaunchConfiguration;
}) {
  const { t } = useTranslation('previews');
  const profile = configuration.profile;
  if (!profile) return <p role="alert">{t('recipeMissing')}</p>;
  return (
    <div className="min-w-0 space-y-3 text-sm">
      {configuration.stale && (
        <p role="alert" className="text-amber-700 dark:text-amber-400">
          {t('recipeStale')}
        </p>
      )}
      <p className="break-all">
        {t('source.label')}: {configuration.sourcePath ?? t('notConfigured')}
      </p>
      <p>
        {t('runtime')}: <code>{profile.runtime}</code> · {t('directory')}:{' '}
        <code>{profile.directory}</code> · {t('port')}: {profile.port}
      </p>
      {(['install', 'build', 'start'] as const).map((key) => (
        <div key={key}>
          <p className="mb-1 font-medium">
            {
              { install: t('install'), build: t('build'), start: t('start') }[
                key
              ]
            }
          </p>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted p-2 text-xs">
            {profile[key] || t('noCommand')}
          </pre>
        </div>
      ))}
      {profile.services.map((service) => (
        <div key={service.name}>
          <p>
            {service.name} · {service.runtime}
          </p>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted p-2 text-xs">
            {service.command}
          </pre>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t('launchCommandsHelp')}</p>
    </div>
  );
}
export function PreviewLaunchDialog({
  projectId,
  threadId,
  action,
  busy,
  onClose,
  onConfirm,
}: {
  projectId: string;
  threadId: string;
  action: 'start' | 'refresh' | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (revision: string) => void;
}) {
  const { t } = useTranslation('previews');
  const query = useQuery({
    queryKey: ['preview-launch-configuration', projectId, threadId],
    queryFn: ({ signal }) =>
      projectsApi<LaunchConfiguration>(
        `/${projectId}/agents/${threadId}/preview/recipe`,
        { signal },
      ),
    enabled: !!action,
    staleTime: 0,
    retry: false,
  });
  return (
    <Dialog
      open={!!action}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent
        style={{ background: 'var(--background)' }}
        className="flex max-h-[85dvh] min-w-0 flex-col sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{t('launchReview')}</DialogTitle>
          <DialogDescription>
            {t(action === 'refresh' ? 'recreateConfirm' : 'launchReviewHelp')}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {query.isFetching ? (
            <p role="status">{t('loading')}</p>
          ) : query.isError ? (
            <p role="alert">{t('unavailable')}</p>
          ) : (
            query.data && <PreviewCommands configuration={query.data} />
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t pt-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('cancel', { ns: 'common' })}
          </Button>
          <Button
            disabled={
              busy ||
              query.isFetching ||
              query.isError ||
              !query.data?.profile ||
              query.data.stale ||
              !query.data.revision ||
              !query.data.sourcePath ||
              !!query.data.sourceError
            }
            onClick={() => {
              if (query.data?.revision) onConfirm(query.data.revision);
            }}
          >
            {t('confirmLaunch')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function PreparedPreviewRecipes({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation('previews');
  const [selected, setSelected] = useState('');
  const agents = useQuery({
    queryKey: ['preview-prepared-agents', projectId],
    queryFn: ({ signal }) =>
      projectsApi<{ agents: { threadId: string }[] }>(
        `/${projectId}/test-environment/recipes`,
        { signal },
      ),
  });
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const names = projects.data?.projects.find(
    (p) => p.id === projectId,
  )?.agentThreads;
  return (
    <section
      className="space-y-2 rounded border p-3"
      aria-label={t('preparedRecipes')}
    >
      <h3 className="text-sm font-medium">{t('preparedRecipes')}</h3>
      <p className="text-xs text-muted-foreground">
        {t('preparedRecipesHelp')}
      </p>
      {disabled && (
        <p role="status" className="text-xs">
          {t('savePolicyFirst')}
        </p>
      )}
      {agents.isPending ? (
        <p>{t('loading')}</p>
      ) : agents.isError ? (
        <p role="alert">{t('unavailable')}</p>
      ) : !agents.data.agents.length ? (
        <p className="text-sm text-muted-foreground">{t('recipeMissing')}</p>
      ) : (
        agents.data.agents.map((agent) => (
          <div
            key={agent.threadId}
            className="flex min-w-0 items-center justify-between gap-2 rounded border p-2 text-sm"
          >
            <span className="truncate">
              {names?.find((a) => a.threadId === agent.threadId)?.title ||
                agent.threadId}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setSelected(agent.threadId)}
            >
              {t('reviewRecipe')}
            </Button>
          </div>
        ))
      )}
      {selected && (
        <RecipeDialog
          key={selected}
          projectId={projectId}
          threadId={selected}
          onClose={() => setSelected('')}
        />
      )}
    </section>
  );
}
function RecipeDialog({
  projectId,
  threadId,
  onClose,
}: {
  projectId: string;
  threadId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('previews');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['preview-recipe', projectId, threadId],
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      projectsApi<LaunchConfiguration>(
        `/${projectId}/agents/${threadId}/preview/recipe`,
        { signal },
      ),
    retry: false,
  });
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        style={{ background: 'var(--background)' }}
        className="flex max-h-[85dvh] flex-col sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{t('reviewRecipe')}</DialogTitle>
          <DialogDescription>{t('recipeEditHelp')}</DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <p>{t('loading')}</p>
        ) : query.isError ? (
          <p role="alert">{t('unavailable')}</p>
        ) : (
          query.data.profile && (
            <RecipeEditor
              key={query.data.recipeRevision}
              configuration={query.data}
              projectId={projectId}
              threadId={threadId}
              onSaved={() => {
                void client.invalidateQueries({
                  queryKey: ['agent-preview', projectId, threadId],
                });
                void client.invalidateQueries({
                  queryKey: ['preview-recipe', projectId, threadId],
                  refetchOnWindowFocus: false,
                  refetchOnReconnect: false,
                });
              }}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
function RecipeEditor({
  configuration,
  projectId,
  threadId,
  onSaved,
}: {
  configuration: LaunchConfiguration;
  projectId: string;
  threadId: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation('previews');
  const [profile, setProfile] = useState(configuration.profile!);
  const [environment, setEnvironment] = useState(
    JSON.stringify(profile.env, null, 2),
  );
  const [services, setServices] = useState(
    JSON.stringify(profile.services, null, 2),
  );
  const save = useMutation({
    mutationFn: () => {
      const {
        runtime,
        directory,
        install,
        build,
        start,
        port,
        path,
        updateMode,
      } = profile;
      return projectsApi(`/${projectId}/agents/${threadId}/preview/recipe`, {
        method: 'PUT',
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedRevision: configuration.recipeRevision,
          policyRevision: configuration.policyRevision,
          recipe: {
            runtime,
            directory,
            install,
            build,
            start,
            port,
            path,
            updateMode,
            env: JSON.parse(environment),
            services: JSON.parse(services),
          },
        }),
      });
    },
    onSuccess: onSaved,
  });
  return (
    <>
      <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
        {configuration.stale && <p role="status">{t('recipeStale')}</p>}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {(['runtime', 'directory', 'port', 'path'] as const).map((key) => (
            <label className="grid min-w-0 gap-1 text-sm" key={key}>
              {
                {
                  runtime: t('runtime'),
                  directory: t('directory'),
                  port: t('port'),
                  path: t('path'),
                }[key]
              }
              <input
                className="min-w-0 rounded border bg-background p-2"
                value={profile[key]}
                type={key === 'port' ? 'number' : 'text'}
                onChange={(e) =>
                  setProfile((p) => ({
                    ...p,
                    [key]:
                      key === 'port' ? Number(e.target.value) : e.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
        {(['install', 'build', 'start'] as const).map((key) => (
          <label className="grid gap-1 text-sm" key={key}>
            {
              { install: t('install'), build: t('build'), start: t('start') }[
                key
              ]
            }
            <textarea
              spellCheck={false}
              className="min-h-16 rounded border bg-background p-2 font-mono text-xs"
              value={profile[key]}
              onChange={(e) =>
                setProfile((p) => ({ ...p, [key]: e.target.value }))
              }
            />
          </label>
        ))}
        <label className="grid gap-1 text-sm">
          {t('updateMode')}
          <select
            className="rounded border bg-background p-2"
            value={profile.updateMode}
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                updateMode: e.target.value as PreviewProfile['updateMode'],
              }))
            }
          >
            {(['hot', 'restart', 'manual'] as const).map((mode) => (
              <option key={mode} value={mode}>
                {t(mode === 'restart' ? 'restartMode' : mode)}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary className="cursor-pointer text-sm">{t('advanced')}</summary>
          <p className="py-2 text-xs text-muted-foreground">
            {t('secretsHelp')}
          </p>
          <label className="grid gap-1 text-sm">
            {t('environment')}
            <textarea
              className="min-h-20 rounded border bg-background p-2 font-mono text-xs"
              spellCheck={false}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </label>
          <label className="mt-3 grid gap-1 text-sm">
            {t('services')}
            <textarea
              className="min-h-28 rounded border bg-background p-2 font-mono text-xs"
              spellCheck={false}
              value={services}
              onChange={(e) => setServices(e.target.value)}
            />
          </label>
        </details>
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof Error ? save.error.message : t('saveFailed')}
        </p>
      )}
      {save.isSuccess && <p role="status">{t('saved')}</p>}
      <div className="flex shrink-0 justify-end border-t pt-3">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {t('saveRecipe')}
        </Button>
      </div>
    </>
  );
}
