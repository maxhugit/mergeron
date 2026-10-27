import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { translationKey } from '@/locales/translation-key';
import {
  managerStatusQueryKey,
  requestManagerAdoption,
  requestManagerStatus,
  type ManagerComponent,
} from './manager-status-api';

const stateLabels = {
  missing: 'managerStateMissing',
  conflict: 'transferActionConflict',
  created: 'created',
  stopped: 'managerStateStopped',
  running: 'running',
  starting: 'managerStateStarting',
  healthy: 'managerStateHealthy',
  unhealthy: 'managerStateUnhealthy',
} as const;

const adoptionLabels = {
  managed: 'managerAdoptionManaged',
  adoptable: 'managerAdoptionAdoptable',
  missing: 'notInstalled',
  conflict: 'managerAdoptionConflict',
} as const;

function ComponentRow({ component }: { component: ManagerComponent }) {
  const { t } = useTranslation();
  const { t: tm } = useTranslation('manager');
  const healthy = component.state === 'healthy';
  const warning = ['unhealthy', 'stopped', 'conflict', 'missing'].includes(
    component.state,
  );
  return (
    <li className="space-y-2 rounded-lg border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'h-2.5 w-2.5 shrink-0 rounded-full',
              healthy
                ? 'bg-emerald-500'
                : warning
                  ? 'bg-destructive'
                  : 'bg-amber-500',
            )}
          />
          <span className="truncate text-sm font-medium">
            {component.displayName}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {t(translationKey(stateLabels[component.state]))}
        </span>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <span>
          {t('managerAdoption')}:{' '}
          {t(translationKey(adoptionLabels[component.adoption]))}
        </span>
        {component.containerName && (
          <span className="truncate sm:text-right">
            {component.containerName}
          </span>
        )}
      </div>
      {component.missingNetworks.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-300">
          {t('missingNetworks')}: {component.missingNetworks.join(', ')}
        </p>
      )}
      {component.image && (
        <p className="break-all font-mono text-xs text-muted-foreground">
          {component.image}
        </p>
      )}
      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">
            {tm('managerContainerNetworks')}
          </dt>
          <dd className="break-all">{component.networks.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {tm('managerContainerRestarts')}
          </dt>
          <dd>{component.restartCount}</dd>
        </div>
        {component.configuration && (
          <>
            <div>
              <dt className="text-muted-foreground">
                {tm('managerContainerNetworkMode')}
              </dt>
              <dd>{component.configuration.networkMode || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {tm('managerContainerRestartPolicy')}
              </dt>
              <dd>{component.configuration.restartPolicy || '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">
                {tm('managerContainerEnvironment')}
              </dt>
              <dd>
                <ul className="mt-1 grid gap-1 font-mono sm:grid-cols-2">
                  {component.configuration.environment.map((entry) => (
                    <li key={entry.name} className="break-all">
                      {entry.name} ={' '}
                      {entry.value ?? tm('managerContainerHiddenValue')}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </>
        )}
      </dl>
    </li>
  );
}

export function ManagerStatusCard() {
  const { t, i18n } = useTranslation();
  const { t: tm } = useTranslation('manager');
  const queryClient = useQueryClient();
  const [confirmAdoption, setConfirmAdoption] = useState(false);
  const query = useQuery({
    queryKey: managerStatusQueryKey,
    queryFn: requestManagerStatus,
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: false,
  });
  const data = query.data;
  const nativelyManaged =
    data?.components.length === 3 &&
    new Set(data.components.map((component) => component.id)).size === 3 &&
    data.components.every((component) => component.adoption === 'managed');
  const canAdopt =
    !!data?.available &&
    data.adoption?.state === 'eligible' &&
    data.adoption.canAdopt &&
    !nativelyManaged &&
    data.dataSafety.status === 'protected' &&
    !data.update?.busy;
  const error = query.error?.message ?? data?.error;
  const adoption = useMutation({
    mutationFn: requestManagerAdoption,
    onSuccess: (status) => {
      queryClient.setQueryData(managerStatusQueryKey, status);
      setConfirmAdoption(false);
    },
  });

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Mergeron Manager</h2>
          {!data?.update && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {t('observationOnly')}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {data?.update
            ? tm('managerUpdateSafetyDescription')
            : t(
                'managerObservesTheExistingStackWithoutChangingContainersOrData',
              )}
        </p>
      </div>

      {query.isLoading && (
        <p className="text-sm text-muted-foreground">{t('loadingb04ba49f')}</p>
      )}

      {error && (
        <div className="space-y-1 rounded-lg border border-border bg-background/60 p-3">
          <p role="status" className="text-sm font-medium">
            {t('managerNotConnected')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('theCurrentInstallationContinuesToRunWithoutManager')}
          </p>
          {query.error && (
            <p role="alert" className="text-xs text-destructive">
              {t(translationKey(error))}
            </p>
          )}
        </div>
      )}

      {data?.available && (
        <>
          <div
            role="status"
            className={cn(
              'rounded-lg border p-3 text-sm',
              data.dataSafety.status === 'protected'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
            )}
          >
            {t(
              data.dataSafety.status === 'protected'
                ? 'persistentDataMountsAreProtected'
                : 'managerWillNotModifyThisInstallationBecauseDataProtectionChecksFailed',
            )}
          </div>

          {data.adoption?.state === 'adopted' && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
              <p className="font-medium">{t('managerInstallationAdopted')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('managerAdoptionDoesNotMoveOrRecreateData')}
              </p>
            </div>
          )}

          {nativelyManaged &&
            data.adoption?.state !== 'adopted' &&
            data.adoption?.state !== 'drifted' &&
            data.dataSafety.status === 'protected' && (
              <p
                role="status"
                className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
              >
                {tm('managerInstallationAlreadyManaged')}
              </p>
            )}

          {data.adoption?.state === 'drifted' && !data.update?.busy && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {t('managerAdoptedInstallationChanged')}
            </div>
          )}

          <ul className="grid gap-3">
            {data.components.map((component) => (
              <ComponentRow key={component.id} component={component} />
            ))}
          </ul>

          {data.dataSafety.protectedMounts.length > 0 && (
            <section className="rounded-lg border border-border bg-background/60 p-3 text-xs">
              <h3 className="font-medium">{t('protectedPersistentData')}</h3>
              <ul className="mt-2 space-y-2 text-muted-foreground">
                {data.dataSafety.protectedMounts.map((mount) => (
                  <li key={`${mount.component}:${mount.target}`}>
                    <span className="font-mono">{mount.target}</span>
                    {' → '}
                    <span className="break-all font-mono">
                      {mount.source ?? t('missing')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.observedAt && (
            <p className="text-xs text-muted-foreground">
              {t('lastChecked')}:{' '}
              {new Date(data.observedAt).toLocaleString(i18n.language)}
            </p>
          )}

          {canAdopt && (
            <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                {t('managerAdoptionReadyDescription')}
              </p>
              <Button
                type="button"
                onClick={() => setConfirmAdoption(true)}
                disabled={adoption.isPending}
              >
                {t('adoptExistingInstallation')}
              </Button>
            </div>
          )}

          {adoption.error && (
            <p role="alert" className="text-xs text-destructive">
              {t(translationKey(adoption.error.message))}
            </p>
          )}
        </>
      )}

      <AlertDialog
        open={confirmAdoption && canAdopt}
        onOpenChange={setConfirmAdoption}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('confirmExistingInstallationAdoption')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmExistingInstallationAdoptionDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                !canAdopt || !data?.adoption?.fingerprint || adoption.isPending
              }
              onClick={() => {
                const fingerprint = data?.adoption?.fingerprint;
                if (canAdopt && fingerprint && !adoption.isPending)
                  adoption.mutate(fingerprint);
              }}
            >
              {t('confirmAdoption')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
