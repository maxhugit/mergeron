import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import { gitPath, type GitSnapshot } from '@/lib/workspace-git-api';

interface Review {
  reviewFingerprint: string;
  files: Array<{
    path: string;
    text: string;
    binary: boolean;
    deleted: boolean;
    truncated: boolean;
  }>;
}
export function GitStageChanges({
  projectId,
  copyId,
  snapshot,
  agentThreadId,
  writable,
  onDiff,
}: {
  projectId: string;
  copyId: string;
  snapshot: GitSnapshot;
  agentThreadId?: string;
  writable: boolean;
  onDiff: (path: string) => void;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [review, setReview] = useState<{
    data: Review;
    paths: string[];
    fingerprint: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<string[] | null>(null);
  const request = <T,>(operation: string, body: object) =>
    projectsApi<T>(
      gitPath(projectId, `copies/${encodeURIComponent(copyId)}/${operation}`),
      { method: 'POST', body: JSON.stringify({ ...body, agentThreadId }) },
    );
  const action = useMutation({
    retry: false,
    mutationFn: async ({
      operation,
      paths,
    }: {
      operation: 'review' | 'stage' | 'unstage';
      paths: string[];
    }) => {
      setError('');
      if (operation === 'review') {
        const data = await request<Review>('stage-review', {
          paths,
          fingerprint: snapshot.fingerprint,
        });
        setReview({ data, paths, fingerprint: snapshot.fingerprint! });
        return;
      }
      if (operation === 'stage') {
        if (!review) throw new Error();
        await request('stage', {
          paths: review.paths,
          fingerprint: review.fingerprint,
          reviewFingerprint: review.data.reviewFingerprint,
        });
        setReview(null);
        setSelection(null);
      } else
        await request('unstage', { paths, fingerprint: snapshot.fingerprint });
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['workspace-git', projectId, copyId],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-staged', projectId, copyId],
        }),
      ]);
    },
    onError: () => {
      setReview(null);
      setError(t('gitStageError'));
    },
  });
  const unstaged = snapshot.changes.filter(
    (c) => c.status === '??' || c.status[1] !== ' ',
  );
  const staged = snapshot.changes.filter(
    (c) => ![' ', '?'].includes(c.status[0]),
  );
  const selected = selection ?? unstaged.map((c) => c.path);
  const busy = action.isPending;
  return (
    <div className="space-y-4 text-xs">
      {!snapshot.changes.length && <p>{t('gitClean')}</p>}
      {[
        [t('gitUnprepared'), unstaged, false],
        [t('gitPrepared'), staged, true],
      ].map(([title, items, prepared]) => {
        const changes = items as GitSnapshot['changes'];
        return (
          <section key={String(title)} className="space-y-2">
            <h4 className="font-medium">
              {String(title)} ({changes.length})
            </h4>
            {changes.map((change) => (
              <div
                key={change.path}
                className="flex min-w-0 items-center gap-1"
              >
                {!prepared && writable && (
                  <input
                    type="checkbox"
                    aria-label={t('gitSelectFile', { path: change.path })}
                    checked={selected.includes(change.path)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelection(
                        event.target.checked
                          ? [...selected, change.path]
                          : selected.filter((p) => p !== change.path),
                      )
                    }
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto min-w-0 flex-1 justify-start gap-2 py-2 text-xs"
                  title={change.path}
                  onClick={() => onDiff(change.path)}
                >
                  <code className="shrink-0 whitespace-pre text-primary">
                    {change.status}
                  </code>
                  <span className="truncate">{change.path}</span>
                </Button>
                {writable && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      action.mutate({
                        operation: prepared ? 'unstage' : 'review',
                        paths: [change.path],
                      })
                    }
                  >
                    {t(prepared ? 'gitUnstage' : 'gitStage')}
                  </Button>
                )}
              </div>
            ))}
            {!prepared && changes.length > 0 && writable && (
              <Button
                size="sm"
                disabled={
                  busy ||
                  !selected.some((p) => changes.some((c) => c.path === p))
                }
                onClick={() =>
                  action.mutate({
                    operation: 'review',
                    paths: selected.filter((p) =>
                      changes.some((c) => c.path === p),
                    ),
                  })
                }
              >
                {t('gitStageSelected')}
              </Button>
            )}
          </section>
        );
      })}
      <p className="text-muted-foreground">{t('gitStageHelp')}</p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
      >
        <DialogContent
          className="flex max-h-[85dvh] min-w-0 flex-col"
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('gitStageConfirm')}</DialogTitle>
            <DialogDescription>{t('gitStageReviewHelp')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-3 overflow-auto">
            {review?.data.files.map((file) => (
              <section key={file.path}>
                <h4 className="break-all font-medium">{file.path}</h4>
                {file.deleted ? (
                  <p>{t('gitStageDeletion')}</p>
                ) : file.binary ? (
                  <p>{t('gitStageBinary')}</p>
                ) : (
                  <pre className="overflow-auto rounded bg-muted p-2 text-xs">
                    {file.text}
                  </pre>
                )}
                {file.truncated && <p>{t('gitStageTruncated')}</p>}
              </section>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              {t('gitActionCancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action.mutate({
                  operation: 'stage',
                  paths: review?.paths ?? [],
                })
              }
            >
              {t('gitStageConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
