import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Folder, File, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { filesReadTreeOptions } from '@/generated/api/@tanstack/react-query.gen';

/** Administrative inspection only. No mutation actions or navigation above this root. */
export function SystemWorkspaceTree({
  root,
  onFile,
}: {
  root: string;
  onFile: (path: string) => void;
}) {
  const { t } = useTranslation('workspaces');
  const [directory, setDirectory] = useState(root);
  const query = useQuery({
    ...filesReadTreeOptions({ query: { root: directory } }),
    retry: false,
  });
  return (
    <section
      className="min-h-0 flex-1 overflow-auto p-3 text-xs"
      aria-label={t('systemWorkspace')}
    >
      <p className="mb-3 flex items-center gap-2">
        <LockKeyhole className="h-4 w-4" />
        {t('systemWorkspaceHelp')}
      </p>
      {directory !== root && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setDirectory(directory.split('/').slice(0, -1).join('/'))
          }
        >
          {t('gitParentFolder')}
        </Button>
      )}
      <p className="my-2 break-all font-mono">
        {directory === root ? '/' : directory.slice(root.length)}
      </p>
      {query.isPending ? (
        <p role="status">{t('gitLoading')}</p>
      ) : query.isError ? (
        <div>
          <p role="alert">{t('systemWorkspaceError')}</p>
          <Button size="sm" onClick={() => void query.refetch()}>
            {t('gitRetry')}
          </Button>
        </div>
      ) : (
        query.data.map((entry) => (
          <Button
            key={entry.path}
            variant="ghost"
            className="h-auto w-full justify-start break-all text-left text-xs"
            onClick={() => {
              if (entry.type === 'directory') setDirectory(entry.path);
              else onFile(entry.path);
            }}
          >
            {entry.type === 'directory' ? (
              <Folder className="h-4 w-4 shrink-0" />
            ) : (
              <File className="h-4 w-4 shrink-0" />
            )}
            {entry.name}
          </Button>
        ))
      )}
    </section>
  );
}
