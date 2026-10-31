import { useTranslation } from 'react-i18next';
import type { PreviewStorageStatus } from '../../../../runtime/preview-storage.cjs';
import { PreviewStorageSummary } from './preview-storage-summary';

export function PreviewStorageMeters({
  storage,
}: {
  storage: PreviewStorageStatus;
}) {
  const { t } = useTranslation('previews');
  const labels = {
    workspace: t('storageRoles.workspace'),
    cache: t('storageRoles.cache'),
    temporary: t('storageRoles.temporary'),
    data: t('storageRoles.data'),
  };
  return (
    <section
      aria-label={t('storageTitle')}
      className="shrink-0 space-y-2 border-b pb-3"
    >
      <h3 className="text-sm font-medium">{t('storageTitle')}</h3>
      <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
        {(['workspace', 'cache', 'temporary', 'data'] as const).map((role) => {
          const mount = storage.observation?.mounts.find(
            (m) => m.role === role,
          );
          const used = mount
            ? Math.max(0, mount.totalBytes - mount.availableBytes)
            : null;
          const percent =
            mount && mount.totalBytes > 0
              ? Math.min(100, ((used ?? 0) / mount.totalBytes) * 100)
              : null;
          return (
            <div key={role} className="min-w-0 text-xs">
              <p>{labels[role]}</p>
              <p className="mt-1 tabular-nums text-muted-foreground">
                {mount
                  ? `${Math.round((used ?? 0) / 1024 ** 2)} / ${Math.round(mount.totalBytes / 1024 ** 2)} MiB`
                  : t('metricsUnavailable')}
              </p>
              {percent !== null && (
                <meter
                  aria-label={labels[role]}
                  min={0}
                  max={100}
                  value={percent}
                  className="mt-1 h-2 w-full"
                />
              )}
            </div>
          );
        })}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {t('storageDetails')}
        </summary>
        <div className="mt-2 max-h-32 overflow-auto overscroll-contain">
          <PreviewStorageSummary {...storage} />
        </div>
      </details>
    </section>
  );
}
