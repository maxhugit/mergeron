import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';
import { technicalFileActivity } from '@/lib/technical-file-activity';
export function TechnicalFileList({ items }: { items: TurnItem[] }) {
  const { t } = useTranslation(['workspaces', 'common']);
  const files = technicalFileActivity(items);
  if (!files.length) return null;
  return (
    <ul
      aria-label={t('technicalFilesTitle')}
      className="space-y-1 rounded-lg border border-border/50 p-2 text-xs"
    >
      {files.map((file) => (
        <li
          key={`${file.action}:${file.path}`}
          className="flex min-w-0 items-start gap-2"
        >
          <FileText
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="shrink-0 text-muted-foreground">
            {file.action === 'read'
              ? t('technicalFileRead')
              : file.action === 'add'
                ? t('technicalFileCreate')
                : file.action === 'delete'
                  ? t('technicalFileDelete')
                  : t('technicalFileUpdate')}
          </span>
          <span className="min-w-0 break-all font-mono">{file.path}</span>
          {file.state !== 'completed' && (
            <span className="shrink-0 text-muted-foreground">
              ·{' '}
              {file.state === 'running'
                ? t('inProgress', { ns: 'common' })
                : file.state === 'declined'
                  ? t('declined', { ns: 'common' })
                  : t('agentElapsedFailed', { ns: 'common' })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
