import { useTranslation } from 'react-i18next';
import type {
  PreviewStorageLimits,
  PreviewStorageStatus,
} from '../../../../runtime/preview-storage.cjs';

export function PreviewStorageSummary({
  limits,
  observation,
}: {
  limits: PreviewStorageLimits;
  observation?: PreviewStorageStatus['observation'];
}) {
  const { t } = useTranslation('previews');
  return (
    <section
      aria-label={t('storageTitle')}
      className="min-w-0 space-y-1 text-xs"
    >
      <p>
        {t('storageLimits', {
          workspace: limits.workspaceMb,
          cache: limits.cacheMb,
          temporary: limits.temporaryMb,
          data: limits.dataMb,
        })}
      </p>
      <p className="text-muted-foreground">{t('storageMemoryHelp')}</p>
      {observation?.mounts.map((m) => (
        <p key={m.role} role={m.cause ? 'alert' : undefined}>
          {m.path}:{' '}
          {t('storageAvailable', {
            mib: Math.floor(m.availableBytes / 1024 ** 2),
            inodes: m.availableInodes ?? t('notConfigured'),
          })}
          {m.cause && (
            <>
              {' '}
              —{' '}
              {t(
                m.cause === 'space_exhausted'
                  ? 'storageSpaceExhausted'
                  : 'storageInodesExhausted',
              )}
            </>
          )}
        </p>
      ))}
      {observation && (
        <p className="text-muted-foreground">
          {t('storageMeasuredAt', {
            time: new Date(observation.checkedAt).toLocaleTimeString(),
          })}
        </p>
      )}
    </section>
  );
}
