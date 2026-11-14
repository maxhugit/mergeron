import { useTranslation } from 'react-i18next';
import { usePreviewRuntimeDiagnostics } from '@/lib/use-preview-runtime-diagnostics';

export function PreviewRuntimeDiagnostics({
  projectId,
  threadId,
  runId,
}: {
  projectId: string;
  threadId: string;
  runId: string;
}) {
  const { t } = useTranslation('previews');
  const causeLabels = {
    memory_limit: t('runtimeDiagnostics.causes.memoryLimit'),
    process_exit: t('runtimeDiagnostics.causes.processExit'),
    startup_timeout: t('runtimeDiagnostics.causes.startupTimeout'),
    user_stop: t('runtimeDiagnostics.causes.userStop'),
    expired: t('runtimeDiagnostics.causes.expired'),
  };
  const query = usePreviewRuntimeDiagnostics(projectId, threadId, runId);
  // Keep a previous run's cached result out of the current environment.
  const data = query.data?.runId === runId ? query.data : null;
  return (
    <details className="min-w-0 shrink-0 border-b px-3 py-2 text-xs">
      <summary className="cursor-pointer">
        {t('runtimeDiagnostics.title')}
      </summary>
      <div className="mt-2 space-y-2 break-words">
        {query.isError || !data ? (
          <p>{t('metricsUnavailable')}</p>
        ) : (
          <>
            {data.execution ? (
              <p>{t('runtimeDiagnostics.execution', data.execution)}</p>
            ) : (
              <p>{t('runtimeDiagnostics.legacy')}</p>
            )}
            {data.runtimeVersions ? (
              <p>
                {t('executionChecks.versions', {
                  node: data.runtimeVersions.node ?? '—',
                  npm: data.runtimeVersions.npm ?? '—',
                  pnpm: data.runtimeVersions.pnpm ?? '—',
                  corepack: data.runtimeVersions.corepack ?? '—',
                  date: new Date(
                    data.runtimeVersions.checkedAt,
                  ).toLocaleString(),
                })}
              </p>
            ) : (
              <p>{t('executionChecks.versionsUnknown')}</p>
            )}
            {data.termination && (
              <div role="status">
                <p>{causeLabels[data.termination.cause]}</p>
                <p>
                  {t('runtimeDiagnostics.exit', {
                    exitCode: data.termination.exitCode ?? '—',
                    date: new Date(
                      data.termination.observedAt,
                    ).toLocaleString(),
                  })}
                </p>
              </div>
            )}
          </>
        )}
        <p className="text-muted-foreground">{t('runtimeDiagnostics.help')}</p>
        <p className="text-muted-foreground">
          {t('runtimeDiagnostics.stopHelp')}
        </p>
      </div>
    </details>
  );
}
