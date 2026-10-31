import {
  useId,
  useState,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ListPlus, LoaderCircle } from 'lucide-react';
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
export interface GitStageHandle {
  review: (path: string) => void;
  unstage: (path: string) => void;
}

export function GitStageChanges({
  projectId,
  copyId,
  snapshot,
  agentThreadId,
  writable,
  onDiff,
  view = 'all',
  layout = 'flow',
  preparedActions,
  ref,
}: {
  projectId: string;
  copyId: string;
  snapshot: GitSnapshot;
  agentThreadId?: string;
  writable: boolean;
  onDiff: (path: string, staged: boolean) => void;
  view?: 'all' | 'prepared' | 'actions';
  layout?: 'flow' | 'split';
  preparedActions?: (busy: boolean) => ReactNode;
  ref?: Ref<GitStageHandle>;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const listsId = useId();
  const split = layout === 'split' && view === 'all';
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
  const selectedPaths = selected.filter((path) =>
    unstaged.some((change) => change.path === path),
  );
  const busy = action.isPending;
  useImperativeHandle(ref, () => ({
    review: (path) => {
      if (writable && !busy && unstaged.some((change) => change.path === path))
        action.mutate({ operation: 'review', paths: [path] });
    },
    unstage: (path) => {
      if (writable && !busy && staged.some((change) => change.path === path))
        action.mutate({ operation: 'unstage', paths: [path] });
    },
  }));
  return (
    <div
      className={
        split
          ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden text-xs'
          : 'space-y-4 text-xs'
      }
    >
      {view === 'prepared' && !staged.length && (
        <p>{t('gitNoPreparedFiles')}</p>
      )}
      {view === 'all' && !snapshot.changes.length && !split && (
        <p>{t('gitClean')}</p>
      )}
      {view !== 'actions' && (
        <div
          className={
            split
              ? 'grid min-h-0 min-w-0 flex-1 grid-rows-2 gap-2'
              : 'space-y-4'
          }
        >
          {[
            {
              id: 'unprepared',
              title: t('gitUnprepared'),
              changes: unstaged,
              prepared: false,
            },
            {
              id: 'prepared',
              title: t('gitPrepared'),
              changes: staged,
              prepared: true,
            },
          ]
            .filter(({ prepared }) => view === 'all' || prepared)
            .map(({ id, title, changes, prepared }) => (
              <section
                key={id}
                aria-labelledby={`${listsId}-${id}`}
                className={
                  split
                    ? 'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border'
                    : 'space-y-2'
                }
              >
                <div
                  className={
                    split
                      ? 'flex min-w-0 shrink-0 items-center justify-between gap-2 border-b px-2 py-1'
                      : 'flex min-w-0 items-center justify-between gap-2'
                  }
                >
                  <h4
                    id={`${listsId}-${id}`}
                    className="min-w-0 truncate font-medium"
                    title={`${title} (${changes.length})`}
                  >
                    {title} ({changes.length})
                  </h4>
                  {prepared ? (
                    preparedActions?.(busy)
                  ) : writable ? (
                    <Button
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={t('gitStageSelected')}
                      title={t('gitStageSelected')}
                      aria-busy={busy}
                      disabled={
                        busy || !snapshot.fingerprint || !selectedPaths.length
                      }
                      onClick={() =>
                        action.mutate({
                          operation: 'review',
                          paths: selectedPaths,
                        })
                      }
                    >
                      {busy ? (
                        <LoaderCircle
                          className="size-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <ListPlus className="size-4" aria-hidden="true" />
                      )}
                    </Button>
                  ) : null}
                </div>
                <ul
                  aria-labelledby={`${listsId}-${id}`}
                  tabIndex={split ? 0 : undefined}
                  className={
                    split
                      ? 'min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
                      : 'space-y-1'
                  }
                >
                  {split && changes.length === 0 && (
                    <li className="p-2 text-muted-foreground">
                      {t(
                        prepared
                          ? 'gitNoPreparedFiles'
                          : 'gitNoUnpreparedFiles',
                      )}
                    </li>
                  )}
                  {changes.map((change) => (
                    <li
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
                        onClick={() => onDiff(change.path, Boolean(prepared))}
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
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}
      {error && (
        <p role="alert" className="shrink-0 text-destructive">
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
