import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import { gitPath, type GitSnapshot } from '@/lib/workspace-git-api';
import { ActionError } from './workspace-git-actions';
import { WorkspaceEntryMenu } from './workspace-entry-menu';

export function GitLocalBranchActions({
  projectId,
  copyId,
  snapshot,
  branch,
  agentThreadId,
  readOnly,
}: {
  projectId: string;
  copyId: string;
  snapshot: GitSnapshot;
  branch: GitSnapshot['branches'][number];
  agentThreadId?: string;
  readOnly: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const submitted = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [review, setReview] = useState<{
    action: 'switch' | 'merge' | 'delete';
    fingerprint?: string;
    revision: string;
    current: string | null;
  } | null>(null);
  const action = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi(
        gitPath(
          projectId,
          `copies/${encodeURIComponent(copyId)}/branch-action`,
        ),
        {
          method: 'POST',
          body: JSON.stringify({
            ...review,
            name: branch.name,
            agentThreadId,
            confirmation:
              review?.action === 'delete'
                ? 'DELETE_LOCAL_BRANCH'
                : 'LOCAL_BRANCH_ACTION',
          }),
        },
      ),
    onSuccess: async () => {
      setReview(null);
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['workspace-git', projectId, copyId],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-commits', projectId, copyId],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-graph', projectId, copyId],
        }),
        client.invalidateQueries({ queryKey: [{ _id: 'filesReadTree' }] }),
      ]);
    },
    onSettled: () => {
      submitted.current = false;
    },
  });
  const disabled =
    readOnly ||
    !snapshot.fingerprint ||
    !snapshot.head ||
    !snapshot.branch ||
    snapshot.changes.length > 0;
  if (branch.remote || branch.name === snapshot.branch) return null;
  return (
    <>
      <WorkspaceEntryMenu
        label={t('gitLocalBranchMenu', { name: branch.name })}
        triggerRef={trigger}
        onCloseAutoFocus={(event) => {
          if (review) event.preventDefault();
        }}
        items={(['switch', 'merge', 'delete'] as const).map((mode) => ({
          label: t(
            mode === 'delete'
              ? 'gitLocalDelete'
              : mode === 'switch'
                ? 'gitLocalSwitch'
                : 'gitLocalMerge',
          ),
          destructive: mode === 'delete',
          disabled: disabled || action.isPending,
          reason:
            snapshot.changes.length > 0
              ? t('gitLocalCleanRequired')
              : undefined,
          onSelect: () => {
            action.reset();
            setReview({
              action: mode,
              fingerprint: snapshot.fingerprint,
              revision: branch.revision,
              current: snapshot.branch,
            });
          },
        }))}
      />
      <Dialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open && !action.isPending) setReview(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (trigger.current?.isConnected) {
              event.preventDefault();
              trigger.current.focus();
            }
          }}
        >
          <DialogTitle>
            {t(
              review?.action === 'delete'
                ? 'gitLocalDelete'
                : review?.action === 'switch'
                  ? 'gitLocalSwitch'
                  : 'gitLocalMerge',
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              review?.action === 'delete'
                ? 'gitLocalDeleteHelp'
                : 'gitLocalActionHelp',
            )}
          </DialogDescription>
          <p className="break-all">
            {review?.action === 'delete'
              ? branch.name
              : review?.action === 'switch'
                ? `${review.current ?? ''} → ${branch.name}`
                : `${branch.name} → ${review?.current ?? ''}`}
          </p>
          <p className="break-all font-mono text-xs">{review?.revision}</p>
          <ActionError error={action.error} />
          <Button
            variant={review?.action === 'delete' ? 'destructive' : 'default'}
            disabled={
              action.isPending ||
              review?.fingerprint !== snapshot.fingerprint ||
              review?.revision !== branch.revision
            }
            onClick={() => {
              if (!submitted.current) {
                submitted.current = true;
                action.mutate();
              }
            }}
          >
            {t('gitLocalConfirm')}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
