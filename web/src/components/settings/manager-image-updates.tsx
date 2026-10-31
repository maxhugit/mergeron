import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  componentUpdatesKey,
  requestComponentUpdates,
} from './manager-image-updates-api';

export function ManagerImageUpdates({
  disabled,
  onUpdate,
}: {
  disabled: boolean;
  onUpdate: (images: Record<string, string>) => void;
}) {
  const { t, i18n } = useTranslation('manager');
  const query = useQuery({
    queryKey: componentUpdatesKey,
    queryFn: () => requestComponentUpdates(),
    staleTime: 60_000,
    refetchInterval: 300_000,
    retry: false,
  });
  return (
    <section aria-label={t('componentUpdatesTitle')} className="space-y-3">
      <h3 className="text-sm font-semibold">{t('componentUpdatesTitle')}</h3>
      {query.isPending && <p role="status">{t('componentUpdatesLoading')}</p>}
      {query.isError && <p role="alert">{t('componentUpdatesUnavailable')}</p>}
      {query.data?.checkedAt && (
        <p className="text-xs text-muted-foreground">
          {t('versionRegistryCheckedAt', {
            date: new Date(query.data.checkedAt).toLocaleString(i18n.language),
          })}
        </p>
      )}
      {query.data?.components.map((item) => (
        <article
          key={item.id}
          className="space-y-2 rounded-lg border border-border p-3 text-sm"
        >
          <h4 className="font-medium">{item.displayName}</h4>
          <p className="text-xs text-muted-foreground">
            {t('versionInstalledImage')}
          </p>
          <p className="break-all font-mono text-xs">
            {item.installedImage ?? '—'}
          </p>
          {(item.installedBuild?.version || item.installedBuild?.revision) && (
            <p className="text-xs">
              {item.installedBuild.version ?? t('versionUnknown')}
              {item.installedBuild.revision
                ? ` · ${item.installedBuild.revision.slice(0, 7)}`
                : ''}
            </p>
          )}
          <p>
            {t(
              item.checkError ||
                (!item.updateAvailable && item.versionStatus !== 'current')
                ? item.checkError === 'platformIdentityUnavailable'
                  ? 'componentPlatformUnknown'
                  : 'componentUpdatesUnknown'
                : item.updateAvailable
                  ? 'componentUpdatesAvailable'
                  : 'componentUpdatesCurrent',
            )}
          </p>
          {item.targetImage && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {t('versionRegistryTarget')}
              </p>
              <p className="break-all font-mono text-xs">
                {item.targetImage}
                {item.targetDigest ? ` · ${item.targetDigest}` : ''}
              </p>
            </div>
          )}
          {item.updateAvailable && (
            <p className="text-xs text-muted-foreground">
              {t('componentUpdatesNotesHelp')}
            </p>
          )}
          {item.notesUrl && (
            <a
              href={item.notesUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              {t('componentUpdatesNotes')}
            </a>
          )}
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                disabled ||
                (!item.updateAvailable && !item.migrationAvailable) ||
                (!!item.checkError && !item.migrationAvailable) ||
                !item.targetDigest ||
                !item.targetImage
              }
              onClick={() => {
                if (
                  !item.targetImage ||
                  !item.targetDigest ||
                  !/^sha256:[a-f0-9]{64}$/.test(item.targetDigest)
                )
                  return;
                const repo = item.targetImage.replace(/:[^/:]+$/, '');
                onUpdate({ [item.id]: `${repo}@${item.targetDigest}` });
              }}
            >
              {t(
                item.migrationAvailable
                  ? 'componentUpdatesMigrate'
                  : 'componentUpdatesInstall',
                { name: item.displayName },
              )}
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
