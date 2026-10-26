/** Read-only Git comparison, independent of the conversation and file editor buffers. */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { gitGet, type GitDiff } from '@/lib/workspace-git-api';
import type { GitDiffTarget } from '@/stores/workspace-store';
import { GitDiffPanel } from './turn-items/git-diff-panel';

export function WorkspaceGitDiff({
  target,
  active,
  onFile,
}: {
  target: GitDiffTarget;
  active: boolean;
  onFile: (path: string) => void;
}) {
  const { t } = useTranslation('workspaces');
  const diff = useQuery({
    queryKey: [
      'workspace-git-diff',
      target.projectId,
      target.copyId,
      target.path,
    ],
    queryFn: ({ signal }) =>
      gitGet<GitDiff>(
        target.projectId,
        `copies/${encodeURIComponent(target.copyId)}/diff?path=${encodeURIComponent(target.path)}`,
        signal,
      ),
    enabled: active,
    staleTime: 0,
    retry: false,
  });
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label={t('gitDiffTabTitle', { name: target.path })}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        <h2 className="min-w-0 flex-1 break-all text-sm font-medium">
          {target.path}
        </h2>
        <Button
          size="sm"
          variant="outline"
          disabled={diff.isFetching}
          onClick={() => void diff.refetch()}
        >
          {t('gitRefresh')}
        </Button>
        {target.localPath && !target.status.includes('D') && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onFile(`${target.localPath}/${target.path}`)}
          >
            {t('gitOpenFile')}
          </Button>
        )}
        <p className="w-full text-xs text-muted-foreground">
          {diff.data?.stagedOnly ? t('gitUnbornDiffHelp') : t('gitDiffHelp')}
        </p>
      </header>
      {diff.isPending ? (
        <p role="status" className="p-4">
          {t('gitLoading')}
        </p>
      ) : diff.isError ? (
        <p role="alert" className="p-4">
          {t('gitDiffError')}
        </p>
      ) : diff.data.untracked ? (
        <p className="p-4">{t('gitUntracked')}</p>
      ) : !diff.data.diff ? (
        <p className="p-4">{t('gitNoTextDiff')}</p>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <div className="grid grid-cols-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium">
            <span>
              {diff.data.stagedOnly
                ? t('gitDiffEmptyBefore')
                : t('gitDiffBefore')}
            </span>
            <span>
              {diff.data.stagedOnly ? t('gitDiffStaged') : t('gitDiffAfter')}
            </span>
          </div>
          <GitDiffPanel
            diff={diff.data.diff}
            filePath={target.path}
            initialSplit
            showToolbar={false}
            maxHeightClassName=""
            className="min-w-0"
          />
        </div>
      )}
    </section>
  );
}
