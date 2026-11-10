import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { post, type Options } from '@/lib/git-deliverables-api';

type Comparison = {
  fingerprint: string;
  context: { branch: string | null; head: string | null };
  version: number;
  mergeron: { path: string; sha256: string; size: number };
  git: {
    path: string;
    exists: boolean;
    sha256: string | null;
    size: number | null;
  };
  actions: ('mergeron' | 'git')[];
};
export function DocumentGitDialog({
  projectId,
  documentId,
  name,
  options,
  onClose,
  onDone,
  onFile,
}: {
  projectId: string;
  documentId: string;
  name: string;
  options?: Options;
  onClose: () => void;
  onDone: () => void;
  onFile: (path: string) => void;
}) {
  const { t } = useTranslation('workspaces');
  const [choice, setChoice] = useState<{
    direction: 'mergeron' | 'git';
    fingerprint: string;
  } | null>(null);
  const direction = choice?.direction;
  const query = useQuery({
    queryKey: ['git-document-comparison', projectId, documentId, options],
    enabled: !!options,
    retry: false,
    queryFn: () =>
      post<Comparison>(projectId, '/document-preview', { options, documentId }),
  });
  const mutation = useMutation({
    mutationFn: () =>
      post(projectId, '/apply', {
        options,
        fingerprint: choice!.fingerprint,
        resolution: {
          documentId,
          direction,
          confirmation: 'CONFIRM_DOCUMENT_RESOLUTION',
        },
      }),
    onSuccess: onDone,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl"
        style={{ backgroundColor: 'var(--background)' }}
      >
        <DialogHeader>
          <DialogTitle>{t('gitDocumentTitle')}</DialogTitle>
          <DialogDescription className="break-words">{name}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-auto text-sm">
          {!options || query.isError ? (
            <p role="alert">{t('gitDocumentUnavailable')}</p>
          ) : query.isPending ? (
            <p role="status">{t('deliverableGitStateChecking')}</p>
          ) : (
            query.data && (
              <>
                <p>
                  {query.data.git.exists
                    ? query.data.git.sha256 === query.data.mergeron.sha256
                      ? t('gitDocumentEqual')
                      : t('gitDocumentDifferent')
                    : t('gitDocumentMissing')}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <section className="space-y-2 rounded border p-3">
                    <strong>Mergeron · V{query.data.version}</strong>
                    <p className="font-mono text-xs">
                      SHA-256 {query.data.mergeron.sha256.slice(0, 12)}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onFile(query.data!.mergeron.path)}
                    >
                      {t('gitDocumentOpenLocal')}
                    </Button>
                  </section>
                  <section className="space-y-2 rounded border p-3">
                    <strong>{t('gitDocumentGit')}</strong>
                    <p className="font-mono text-xs">
                      {query.data.context.branch?.replace(/^refs\/heads\//, '')}{' '}
                      · {query.data.git.sha256?.slice(0, 12) ?? '—'}
                    </p>
                    {query.data.git.exists && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onFile(query.data!.git.path)}
                      >
                        {t('gitDocumentOpenGit')}
                      </Button>
                    )}
                  </section>
                </div>
                {!query.data.actions.length && (
                  <p role="alert">{t('gitDocumentProtected')}</p>
                )}
                {direction ? (
                  <section className="space-y-3 rounded border border-orange-400 p-3">
                    <p>
                      {t(
                        direction === 'mergeron'
                          ? 'gitDocumentConfirmExport'
                          : 'gitDocumentConfirmImport',
                      )}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={mutation.isPending}
                        onClick={() => mutation.mutate()}
                      >
                        {t('gitDocumentConfirm')}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={mutation.isPending}
                        onClick={() => setChoice(null)}
                      >
                        {t('gitDocumentBack')}
                      </Button>
                    </div>
                  </section>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={
                        query.isFetching ||
                        !query.data.actions.includes('mergeron')
                      }
                      onClick={() =>
                        setChoice({
                          direction: 'mergeron',
                          fingerprint: query.data!.fingerprint,
                        })
                      }
                    >
                      {t('gitDocumentUseMergeron')}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={
                        query.isFetching || !query.data.actions.includes('git')
                      }
                      onClick={() =>
                        setChoice({
                          direction: 'git',
                          fingerprint: query.data!.fingerprint,
                        })
                      }
                    >
                      {t('gitDocumentUseGit')}
                    </Button>
                  </div>
                )}
                {mutation.isError && (
                  <p role="alert">{t('gitDocumentChanged')}</p>
                )}
              </>
            )
          )}
        </div>
        <div className="shrink-0 border-t pt-3">
          <Button
            variant="outline"
            disabled={mutation.isPending || query.isFetching}
            onClick={() => {
              setChoice(null);
              mutation.reset();
              void query.refetch();
            }}
          >
            {t('deliverableGitRefresh')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
