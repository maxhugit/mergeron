import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Folder, File } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { gitGet } from '@/lib/workspace-git-api';

interface RemoteFiles {
  ref: string | null;
  path: string;
  items: Array<{
    name: string;
    path: string;
    type: string;
    size: number;
  }> | null;
  limited: boolean;
  content: string | null;
}

/** Remote browsing is read-only and pinned to a SHA. It never adopts a local folder. */
export function GitRemoteFiles({
  projectId,
  resourceId,
}: {
  projectId: string;
  resourceId: string;
}) {
  const { t } = useTranslation('workspaces');
  const [path, setPath] = useState('');
  const [ref, setRef] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['workspace-git-remote-files', projectId, resourceId, path, ref],
    queryFn: ({ signal }) =>
      gitGet<RemoteFiles>(
        projectId,
        `connections/${encodeURIComponent(resourceId)}/files?path=${encodeURIComponent(path)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`,
        signal,
      ),
    retry: false,
  });
  const navigate = (next: string) => {
    setRef(query.data?.ref ?? ref);
    setPath(next);
  };
  return (
    <section
      className="min-w-0 space-y-2 p-3 text-xs"
      aria-label={t('gitBrowseRemote')}
    >
      <p className="text-muted-foreground">{t('gitRemoteFilesHelp')}</p>
      <div className="flex items-center gap-2">
        {path && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(path.split('/').slice(0, -1).join('/'))}
          >
            {t('gitParentFolder')}
          </Button>
        )}
        <span className="min-w-0 flex-1 break-all font-mono">/{path}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isFetching}
          onClick={() => {
            setRef(null);
            setPath('');
            void query.refetch();
          }}
        >
          {t('gitRefresh')}
        </Button>
      </div>
      {query.data?.ref && (
        <p className="text-muted-foreground">
          GitHub · {query.data.ref.slice(0, 7)}
        </p>
      )}
      {query.isPending ? (
        <p role="status">{t('gitLoading')}</p>
      ) : query.isError ? (
        <p role="alert">{t('gitGithubError')}</p>
      ) : (
        <>
          {query.data.items?.map((item) => (
            <Button
              key={item.path}
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-start whitespace-normal break-all text-left text-xs"
              disabled={!['dir', 'file'].includes(item.type)}
              onClick={() => navigate(item.path)}
            >
              {item.type === 'dir' ? (
                <Folder className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <File className="h-3.5 w-3.5 shrink-0" />
              )}
              {item.name}
            </Button>
          ))}
          {query.data.items?.length === 0 && <p>{t('gitRemoteEmpty')}</p>}
          {query.data.items === null &&
            (query.data.content !== null ? (
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border p-2">
                {query.data.content}
              </pre>
            ) : (
              <p>{t('gitRemoteNoPreview')}</p>
            ))}
          {query.data.limited && <p>{t('gitLimited')}</p>}
        </>
      )}
    </section>
  );
}
