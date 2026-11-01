import { translationKey } from '@/locales/translation-key';
/** Administrator-only controls for the managed app-server CLI, not a shell console. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
import {
  codexConfigReadConfigQueryKey,
  codexStatusGetStatusQueryKey,
  modelsListModelsQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { localizedSourceCopy } from '@/lib/catalog-copy';
import { cliStatusQueryKey, requestCli, type CliStatus } from './codex-cli-api';
interface CliReleaseSection {
  heading: string;
  items: string[];
}
interface CliReleaseNote {
  version: string;
  publishedAt: string | null;
  url: string;
  sections: CliReleaseSection[];
}
interface CliReleaseHistory {
  fromVersion: string | null;
  toVersion: string | null;
  releases: CliReleaseNote[];
  releaseError: string | null;
}
const releaseQueryKey = [...cliStatusQueryKey, 'releases'] as const;

export function CodexCliSettings() {
  const { t, i18n } = useTranslation(['common', 'codexSettings'], {
    nsMode: 'fallback',
  });
  const client = useQueryClient();
  const [confirmation, setConfirmation] = useState<
    'install' | 'update' | 'rollback' | 'managed' | null
  >(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const status = useQuery({
    queryKey: cliStatusQueryKey,
    queryFn: () => requestCli<CliStatus>(),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const releases = useQuery({
    queryKey: releaseQueryKey,
    queryFn: () => requestCli<CliReleaseHistory>('/releases'),
    enabled: Boolean(status.data?.updateAvailable),
    staleTime: 15 * 60_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: ({
      action,
      installedVersion,
      latestVersion,
    }: {
      action: 'install' | 'update' | 'rollback' | 'managed';
      installedVersion: string | null;
      latestVersion: string | null;
    }) =>
      requestCli(
        `/${action}`,
        action === 'managed'
          ? {
              releaseId: status.data?.managedRelease?.id,
              manifestSha256: status.data?.managedRelease?.manifestSha256,
              expectedSelection: status.data?.selectedVersion ?? null,
            }
          : {
              ...(action === 'install'
                ? { targetVersion: latestVersion }
                : { expectedVersion: installedVersion }),
              ...(action === 'update' ? { targetVersion: latestVersion } : {}),
            },
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: cliStatusQueryKey }),
        client.invalidateQueries({ queryKey: codexStatusGetStatusQueryKey() }),
        client.invalidateQueries({ queryKey: modelsListModelsQueryKey() }),
        client.invalidateQueries({ queryKey: codexConfigReadConfigQueryKey() }),
      ]);
    },
  });
  const data = status.data;
  const busy = mutation.isPending || data?.busy || checking;
  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      client.setQueryData(
        cliStatusQueryKey,
        await requestCli<CliStatus>('?refresh=true'),
      );
      await client.invalidateQueries({ queryKey: releaseQueryKey });
    } catch (error) {
      setCheckError(String(error));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
        <h3 className="text-sm font-semibold">{t('codexCliOnThisServer')}</h3>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt>{t('installedVersion')}</dt>
          <dd>
            {data?.installationState === 'missing'
              ? t('notInstalled')
              : (data?.installedVersion ?? t('unknown'))}
          </dd>
          {!data?.officialUpdateBlocked && (
            <>
              <dt>{t('latestStableVersion')}</dt>
              <dd>{data?.latestVersion ?? t('unknown')}</dd>
            </>
          )}
          {data?.protection && data.protection !== 'unprotected' && (
            <>
              <dt>{t('managedCliIdentity', { ns: 'codexSettings' })}</dt>
              <dd className="break-all">
                {data.selectedVersion} ·{' '}
                {t(
                  data.protection === 'verified'
                    ? 'managedCliVerified'
                    : data.protection === 'invalid'
                      ? 'managedCliInvalid'
                      : 'managedCliLegacyCustom',
                  { ns: 'codexSettings' },
                )}
              </dd>
            </>
          )}
        </dl>
        {data?.officialUpdateBlocked && (
          <p role="status" className="text-sm">
            {t('managedCliOfficialBlocked', { ns: 'codexSettings' })}
          </p>
        )}
        {data?.managerError && data.officialUpdateBlocked && (
          <p role="alert">
            {t('managedCliManagerUnavailable', { ns: 'codexSettings' })}
          </p>
        )}
        {data?.managedRelease && (
          <section className="space-y-2 text-sm">
            <p>
              {t('managedCliAvailable', { ns: 'codexSettings' })}:{' '}
              <span className="font-mono">{data.managedRelease.id}</span>
            </p>
            <p className="break-all text-xs text-muted-foreground">
              SHA-256: {data.managedRelease.manifestSha256}
            </p>
            <Button
              disabled={
                busy ||
                !data.canManage ||
                data.selectedVersion === data.managedRelease.id
              }
              onClick={() => setConfirmation('managed')}
            >
              {t('installManagedCli', { ns: 'codexSettings' })}
            </Button>
          </section>
        )}
        {data?.checkedAt && (
          <p className="text-xs text-muted-foreground">
            {t('lastChecked')}:{' '}
            {new Date(data.checkedAt).toLocaleString(i18n.language)}
          </p>
        )}
        {status.isLoading && <p>{t('loadingb04ba49f')}</p>}
        {data?.installedVersion && data.latestVersion && (
          <p role="status">
            {data.updateAvailable
              ? t('aCliUpdateIsAvailable')
              : t('noNewerStableCliVersionIsAvailable')}
          </p>
        )}
        {data?.installationState === 'missing' && (
          <p role="status">
            {t('codexCliIsNotInstalledInstallItToEnableConversationsAndAgents')}
          </p>
        )}
        {data?.installationState === 'legacy' && (
          <p className="text-xs text-muted-foreground">
            {t(
              'thisLegacyInstallationRemainsUsableTheNextUpdateWillMigrateCliSelectionToPersisa6644a8d',
            )}
          </p>
        )}
        {[
          data?.installedError,
          data?.checkError,
          checkError,
          status.error?.message,
          mutation.error?.message,
        ]
          .filter(Boolean)
          .map((error, index) => (
            <p
              key={index}
              role="alert"
              className="whitespace-pre-wrap text-sm text-destructive"
            >
              {error!
                .split('\n')
                .map((line) => t(translationKey(line)))
                .join('\n')}
            </p>
          ))}
        {mutation.isSuccess && (
          <p role="status">{t('cliOperationCompleted')}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void check()}
          >
            {t('checkForCliUpdates')}
          </Button>
          <Button
            disabled={
              busy ||
              !data?.canManage ||
              data.officialUpdateBlocked ||
              !data.latestVersion ||
              (data.installationState !== 'missing' && !data.updateAvailable)
            }
            onClick={() =>
              setConfirmation(
                data?.installationState === 'missing' ? 'install' : 'update',
              )
            }
          >
            {t(
              data?.installationState === 'missing'
                ? 'installCodexCli'
                : 'updateCodexCli',
            )}
          </Button>
          {data?.canRollback && (
            <Button
              variant="outline"
              disabled={
                busy || !(data.selectedVersion ?? data.installedVersion)
              }
              onClick={() => setConfirmation('rollback')}
            >
              {t('restorePreviousCli')}
            </Button>
          )}
        </div>
        {busy && (
          <p role="status">{t('cliOperationInProgressDoNotStartNewWork')}</p>
        )}
        {data && !data.canManage && (
          <p className="text-xs text-muted-foreground">
            {t('thisCliInstallationIsManagedExternally')}
          </p>
        )}
      </div>
      {data?.updateAvailable && (
        <section className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">
              {t('changesBetweenFromAndTo', {
                from: data.installedVersion,
                to: data.latestVersion,
              })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                'officialOpenAiReleaseNotesAreTranslatedIntoTheInterfaceLanguageWhenATranslationf3ead718',
              )}
            </p>
          </div>
          {releases.isLoading && (
            <p className="text-sm text-muted-foreground">
              {t('loadingReleaseNotes')}
            </p>
          )}
          {(releases.data?.releaseError || releases.error) && (
            <p role="alert" className="text-sm text-amber-500">
              {t(
                releases.data?.releaseError ??
                  'unableToLoadOfficialCliReleaseNotes',
              )}
            </p>
          )}
          {(releases.data?.releases ?? []).map((release) => (
            <article
              key={release.version}
              className="space-y-3 rounded-lg border border-border bg-background/60 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium">Codex CLI {release.version}</h4>
                {release.publishedAt && (
                  <time
                    dateTime={release.publishedAt}
                    className="text-xs text-muted-foreground"
                  >
                    {new Date(release.publishedAt).toLocaleDateString(
                      i18n.language,
                    )}
                  </time>
                )}
              </div>
              {release.sections.map((section) => (
                <div key={section.heading} className="space-y-1.5">
                  <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(translationKey(section.heading))}
                  </h5>
                  <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                    {section.items.map((item) => (
                      <li key={item}>{localizedSourceCopy(item)}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <a
                href={release.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-primary underline underline-offset-4"
              >
                {t('openTheOfficialReleaseNote')}
              </a>
            </article>
          ))}
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          'cliUpdatesAreInstalledInPersistentStorageWithoutChangingTheContainerImageCodexM8b37678d',
        )}
      </p>
      <p className="text-xs text-amber-500">
        {t(
          'backUpTheCodexHomeBeforeUpdatingANewerCliMayMigrateItsDataRestoringAnOlderBinarf5940f41',
        )}
      </p>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                confirmation === 'managed'
                  ? 'installManagedCli'
                  : confirmation === 'rollback'
                    ? 'restorePreviousCli'
                    : confirmation === 'install'
                      ? 'installCodexCli'
                      : 'updateCodexCli',
                { ns: confirmation === 'managed' ? 'codexSettings' : 'common' },
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                confirmation === 'install'
                  ? 'thisInstallsTheLatestStableCodexCliInPersistentStorageAndStartsTheManagedAppSer62e3737f'
                  : 'thisRestartsTheManagedCodexAppServerTheOperationIsRefusedWhileWorkIsActiveConve1489cd27',
              )}{' '}
              {confirmation === 'managed'
                ? t('managedCliConfirm', {
                    ns: 'codexSettings',
                    release: data?.managedRelease?.id,
                  })
                : confirmation !== 'rollback' && data?.latestVersion}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const expected =
                  confirmation === 'rollback'
                    ? (data?.selectedVersion ?? data?.installedVersion)
                    : data?.installedVersion;
                if (
                  confirmation &&
                  (confirmation === 'managed'
                    ? Boolean(data?.managedRelease)
                    : confirmation === 'install'
                      ? Boolean(data?.latestVersion)
                      : Boolean(expected))
                )
                  mutation.mutate({
                    action: confirmation,
                    installedVersion: expected ?? null,
                    latestVersion: data?.latestVersion ?? null,
                  });
                setConfirmation(null);
              }}
            >
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
