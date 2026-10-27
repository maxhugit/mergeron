import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Cloud, LockKeyhole } from 'lucide-react';
import { gitGet } from '@/lib/workspace-git-api';
import type { GitRemoteFileTarget } from '@/stores/workspace-store';
import type { RemoteFiles } from './git-remote-files';

/** Never enters the local document store: no editing, save action or keyboard save. */
export function WorkspaceGitRemoteFile({
  target,
  active,
}: {
  target: GitRemoteFileTarget;
  active: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const query = useQuery({
    queryKey: [
      'workspace-git-remote-file',
      target.projectId,
      target.resourceId,
      target.ref,
      target.path,
    ],
    queryFn: ({ signal }) =>
      gitGet<RemoteFiles>(
        target.projectId,
        `connections/${encodeURIComponent(target.resourceId)}/files?path=${encodeURIComponent(target.path)}&ref=${encodeURIComponent(target.ref)}`,
        signal,
      ),
    enabled: active,
    retry: false,
    staleTime: Infinity,
  });
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={target.path}>
      <header className="space-y-2 border-b p-3 text-xs">
        <p className="flex items-center gap-2">
          <Cloud className="h-4 w-4" aria-hidden="true" />
          GitHub · <LockKeyhole className="h-4 w-4" aria-hidden="true" />
          {t('gitRemoteReadOnly')}
        </p>
        <p className="break-all font-mono">
          {target.path} · {target.ref.slice(0, 7)}
        </p>
        <p className="text-muted-foreground">{t('gitRemoteReadOnlyHelp')}</p>
      </header>
      {query.isPending ? (
        <p role="status" className="p-3">
          {t('gitLoading')}
        </p>
      ) : query.isError ? (
        <p role="alert" className="p-3">
          {t('gitGithubError')}
        </p>
      ) : query.data.content !== null ? (
        <pre tabIndex={0} className="min-h-0 flex-1 overflow-auto p-3 text-xs">
          <code>{query.data.content}</code>
        </pre>
      ) : (
        <p className="p-3">{t('gitRemoteNoPreview')}</p>
      )}
    </section>
  );
}
