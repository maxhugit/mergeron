import { useTranslation } from 'react-i18next';

/** Only stable server codes reach the UI; never display raw Git diagnostics. */
export function GitInspectionError({ error }: { error: unknown }) {
  const { t } = useTranslation('workspaces');
  const code = error instanceof Error ? error.message : '';
  const message =
    code === 'GIT_OUTPUT_LIMIT_EXCEEDED'
      ? t('gitInspectionOutputLimit')
      : code === 'GIT_COMMAND_TIMEOUT'
        ? t('gitInspectionTimeout')
        : t('gitInspectionError');
  return (
    <p role="alert" className="min-w-0 break-words text-xs text-destructive">
      {message}
    </p>
  );
}
