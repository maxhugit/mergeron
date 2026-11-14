import { useTranslation } from 'react-i18next';
import type { PreviewStorageStatus } from '../../../../runtime/preview-storage.cjs';
import type { PreviewContainer } from '../chat/agent-preview-panel';
import { PreviewStorageMeters } from './preview-storage-meters';
import { usePreviewRuntimeDiagnostics } from '@/lib/use-preview-runtime-diagnostics';
export function PreviewResourceOverview({
  storage,
  application,
  state,
  projectId,
  threadId,
  runId,
}: {
  storage: PreviewStorageStatus;
  application?: PreviewContainer;
  state: string;
  projectId: string;
  threadId: string;
  runId: string;
}) {
  const { t } = useTranslation('previews');
  const diagnostics = usePreviewRuntimeDiagnostics(projectId, threadId, runId);
  const termination =
    !diagnostics.isError && diagnostics.data?.runId === runId
      ? diagnostics.data.termination
      : null;
  const reasons = {
    memory_limit: t('runtimeDiagnostics.causes.memoryLimit'),
    process_exit: t('runtimeDiagnostics.causes.processExit'),
    startup_timeout: t('runtimeDiagnostics.causes.startupTimeout'),
    expired: t('runtimeDiagnostics.causes.expired'),
    user_stop: t('runtimeDiagnostics.causes.userStop'),
  };
  const mib = (n: number | null | undefined) =>
    typeof n === 'number' ? (n / 1024 ** 2).toFixed(1) : '—';
  return (
    <section
      className="max-h-[25%] @xl:max-h-[35%] min-h-0 shrink-0 space-y-2 overflow-y-auto overscroll-contain rounded border p-2 text-xs"
      aria-label={t('resourceProfiles.overview')}
      tabIndex={0}
    >
      <h3 className="font-medium">{t('resourceProfiles.overview')}</h3>
      <p>
        {t('resourceProfiles.memory', {
          usage: mib(application?.memory?.usageBytes),
          limit: mib(application?.memory?.limitBytes),
          processes: mib(application?.memory?.anonymousBytes),
          files: mib(application?.memory?.fileBytes),
          shared: mib(application?.memory?.sharedBytes),
        })}
      </p>
      {application?.metricsCheckedAt && (
        <p>
          {t('resourceProfiles.measured', {
            date: new Date(application.metricsCheckedAt).toLocaleString(),
          })}
        </p>
      )}
      <p className="text-muted-foreground">
        {t('memoryDiagnostics.explanation')}
      </p>
      {termination && <p role="status">{reasons[termination.cause]}</p>}
      {state !== 'running' && <p>{t('resourceProfiles.historical')}</p>}
      <PreviewStorageMeters storage={storage} />
      <p>{t('resourceProfiles.sync')}</p>
      <p>{t('resourceProfiles.destroy')}</p>
    </section>
  );
}
