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
import {
  projectsApi,
  type ProjectWorkspaceCopySummary,
} from '@/lib/projects-api';
import {
  gitInventoryKey,
  gitPath,
  type GitSnapshot,
} from '@/lib/workspace-git-api';
import { WorkspaceEntryMenu } from './workspace-entry-menu';
import { ActionError } from './workspace-git-actions';
import { GitCreatePullRequest } from './git-create-pull-request';

export function GitRemoteBranchMenu({
  projectId,
  resourceId,
  address,
  branch,
  revision,
  copy,
  snapshot,
  canWrite,
  agentThreadId,
  canPrepare,
  onPrepare,
  onRetrieved,
}: {
  projectId: string;
  resourceId: string;
  address: string | null;
  branch: string;
  revision: string;
  copy?: ProjectWorkspaceCopySummary;
  snapshot?: GitSnapshot;
  canWrite: boolean;
  agentThreadId?: string;
  canPrepare: boolean;
  onPrepare: () => void;
  onRetrieved?: (name: string) => void;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const trigger = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const [prOpen, setPrOpen] = useState(false);
  const [review, setReview] = useState<{
    fingerprint: string;
    revision: string;
    name: string;
    address: string | null;
    copyId: string;
    copyName: string;
    current: string | null;
  } | null>(null);
  const existing = snapshot?.branches.some(
    (item) => !item.remote && item.name === branch,
  );
  const disabled =
    !canWrite ||
    copy?.accessMode !== 'read_write' ||
    !copy ||
    !snapshot?.fingerprint ||
    !snapshot.head ||
    existing;
  const action = useMutation({
    retry: false,
    mutationFn: () => {
      if (!review) throw new Error('GIT_STALE');
      return projectsApi(
        gitPath(
          projectId,
          `copies/${encodeURIComponent(review.copyId)}/retrieve-branch`,
        ),
        {
          method: 'POST',
          body: JSON.stringify({
            ...review,
            agentThreadId,
            confirmation: 'RETRIEVE_REMOTE_BRANCH',
          }),
        },
      );
    },
    onSuccess: async () => {
      setReview(null);
      onRetrieved?.(branch);
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['workspace-git', projectId, copy?.id],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-graph', projectId, copy?.id],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-remote-branches', projectId, resourceId],
        }),
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
      ]);
    },
    onSettled: () => {
      submitted.current = false;
    },
  });
  return (
    <>
      <WorkspaceEntryMenu
        label={t('gitRemoteBranchMenu', { name: branch })}
        triggerRef={trigger}
        onCloseAutoFocus={(event) => {
          if (review || prOpen) event.preventDefault();
        }}
        items={[
          {
            label: t('gitCreatePr'),
            disabled: !canWrite || !address,
            onSelect: () => setPrOpen(true),
          },
          {
            label: t('gitRetrieveBranch'),
            disabled: Boolean(disabled || action.isPending),
            reason: existing
              ? t('gitBranchExists')
              : !copy
                ? t('gitRetrieveNeedsCopy')
                : disabled
                  ? t('gitRetrieveUnavailable')
                  : undefined,
            onSelect: () => {
              if (!copy || !snapshot?.fingerprint) return;
              action.reset();
              setReview({
                name: branch,
                revision,
                fingerprint: snapshot.fingerprint,
                address,
                copyId: copy.id,
                copyName: copy.name,
                current: snapshot.branch,
              });
            },
          },
          {
            label: t('gitPrepareCopy'),
            disabled: !canPrepare,
            onSelect: onPrepare,
          },
        ]}
      />
      {prOpen && address && (
        <GitCreatePullRequest
          remote
          open={prOpen}
          onOpenChange={setPrOpen}
          onCloseFocus={() => trigger.current?.focus()}
          projectId={projectId}
          resourceId={resourceId}
          published={{ branch, sha: revision, address }}
        />
      )}
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
          <DialogTitle>{t('gitRetrieveBranch')}</DialogTitle>
          <DialogDescription>{t('gitRetrieveHelp')}</DialogDescription>
          <p className="break-all font-medium">{review?.name}</p>
          <p className="break-all font-mono text-xs">{review?.revision}</p>
          <p className="break-all text-xs">
            {t('gitRetrieveDestination', { name: review?.copyName })}
          </p>
          <p className="break-all text-xs">
            {t('gitRetrieveCurrent', { name: review?.current })}
          </p>
          <ActionError error={action.error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => setReview(null)}
            >
              {t('cancel', { ns: 'common' })}
            </Button>
            <Button
              disabled={
                action.isPending ||
                review?.fingerprint !== snapshot?.fingerprint ||
                review?.revision !== revision ||
                review?.address !== address ||
                review?.copyId !== copy?.id ||
                Boolean(existing)
              }
              onClick={() => {
                if (!submitted.current) {
                  submitted.current = true;
                  action.mutate();
                }
              }}
            >
              {t('gitRetrieveConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
