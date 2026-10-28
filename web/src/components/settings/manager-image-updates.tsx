import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { Button } from '@/components/ui/button';

export interface ComponentImageUpdate {
  id: string;
  displayName: string;
  installedImage: string | null;
  installedDigest: string | null;
  targetImage: string | null;
  targetDigest: string | null;
  versionStatus: 'unknown' | 'current' | 'update_available';
  updateAvailable: boolean;
  notesUrl: string | null;
  checkError: string | null;
  migrationAvailable?: boolean;
}
export const componentUpdatesKey = [
  'administration',
  'component-image-updates',
];
export async function requestComponentUpdates(
  refresh = false,
): Promise<{ checkedAt: string; components: ComponentImageUpdate[] }> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(
      `/api/settings/manager/image-updates${refresh ? '?refresh=true' : ''}`,
    ),
    {
      headers: authorization ? { Authorization: authorization } : {},
    },
  );
  if (!response.ok) throw new Error('managerImageDiscoveryUnavailable');
  const value = (await response.json()) as {
    checkedAt: string;
    components: ComponentImageUpdate[];
  };
  if (!Array.isArray(value.components))
    throw new Error('managerImageDiscoveryUnavailable');
  return value;
}

export function ManagerImageUpdates({
  disabled,
  onUpdate,
}: {
  disabled: boolean;
  onUpdate: (images: Record<string, string>) => void;
}) {
  const { t } = useTranslation('manager');
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
      {query.data?.components.map((item) => (
        <article
          key={item.id}
          className="space-y-2 rounded-lg border border-border p-3 text-sm"
        >
          <h4 className="font-medium">{item.displayName}</h4>
          <p className="break-all font-mono text-xs">
            {item.installedImage ?? '—'}
          </p>
          <p>
            {t(
              item.checkError
                ? 'componentUpdatesUnknown'
                : item.updateAvailable
                  ? 'componentUpdatesAvailable'
                  : 'componentUpdatesCurrent',
            )}
          </p>
          {item.targetImage && (
            <p className="break-all font-mono text-xs">
              {item.targetImage}
              {item.targetDigest ? ` · ${item.targetDigest}` : ''}
            </p>
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
