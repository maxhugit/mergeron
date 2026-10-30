import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import {
  gitGet,
  gitInventoryKey,
  gitPath,
  type GitSnapshot,
  type GitRemoteBranches,
} from '@/lib/workspace-git-api';
import { ActionError } from './workspace-git-actions';

interface Props {
  projectId: string;
  resourceId: string;
  copyId: string;
  copyName: string;
  address: string | null;
  snapshot: GitSnapshot;
  readOnly: boolean;
  agentThreadId?: string;
}

export function GitIntegrateBranch({
  projectId,
  resourceId,
  copyId,
  copyName,
  address,
  snapshot,
  readOnly,
  agentThreadId,
}: Props) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const trigger = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const [review, setReview] = useState<{
    fingerprint: string;
    current: string;
    head: string;
    address: string;
  } | null>(null);
  const [selected, setSelected] = useState<{
    name: string;
    revision: string;
  } | null>(null);
  const [result, setResult] = useState('');
  const branches = useQuery({
    queryKey: ['workspace-git-remote-branches', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<GitRemoteBranches>(
        projectId,
        `connections/${encodeURIComponent(resourceId)}/branches`,
        signal,
      ),
    enabled: !!review,
    retry: false,
  });
  const action = useMutation({
    retry: false,
    mutationFn: () => {
      if (!review || !selected) throw new Error('GIT_STALE');
      return projectsApi<{ branch: string; sha: string }>(
        gitPath(projectId, `copies/${encodeURIComponent(copyId)}/integrate`),
        {
          method: 'POST',
          body: JSON.stringify({
            fingerprint: review.fingerprint,
            address: review.address,
            name: selected.name,
            revision: selected.revision,
            agentThreadId,
            confirmation: 'INTEGRATE_REMOTE_BRANCH',
          }),
        },
      );
    },
    onSuccess: (value) => {
      setResult(value.sha.slice(0, 7));
      setReview(null);
    },
    onSettled: async () => {
      // Fetch may have succeeded even if integration was refused. Refresh both
      // local Git metadata and files; never retry a write automatically.
      await Promise.all([
        ...[
          'workspace-git',
          'workspace-git-commits',
          'workspace-git-graph',
        ].map((key) =>
          client.invalidateQueries({ queryKey: [key, projectId, copyId] }),
        ),
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        client.invalidateQueries({ queryKey: [{ _id: 'filesReadTree' }] }),
      ]);
      submitted.current = false;
    },
  });
  const dirty = snapshot.changes.length > 0;
  const disabled =
    readOnly ||
    dirty ||
    !address ||
    !snapshot.fingerprint ||
    !snapshot.branch ||
    !snapshot.head;
  const stale =
    !!review &&
    (readOnly ||
      dirty ||
      review.fingerprint !== snapshot.fingerprint ||
      review.current !== snapshot.branch ||
      review.head !== snapshot.head ||
      review.address !== address ||
      !selected ||
      !branches.data?.items.some(
        (item) =>
          item.name === selected.name && item.revision === selected.revision,
      ));
  return (
    <div className="space-y-2">
      <Button
        ref={trigger}
        size="sm"
        variant="outline"
        disabled={disabled || action.isPending}
        onClick={() => {
          action.reset();
          setResult('');
          setSelected(null);
          setReview({
            fingerprint: snapshot.fingerprint!,
            current: snapshot.branch!,
            head: snapshot.head,
            address: address!,
          });
        }}
      >
        {t('gitIntegrate')}
      </Button>
      {dirty && (
        <p className="text-muted-foreground">{t('gitLocalCleanRequired')}</p>
      )}
      {result && (
        <p role="status" className="text-primary">
          {t('gitIntegrateDone', { sha: result })}
        </p>
      )}
      <Dialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open && !action.isPending) setReview(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-auto"
          showCloseButton={!action.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogTitle>{t('gitIntegrate')}</DialogTitle>
          <DialogDescription>{t('gitIntegrateHelp')}</DialogDescription>
          <p className="break-all text-sm">
            {t('gitIntegrateDestination', {
              copy: copyName,
              branch: review?.current,
            })}
          </p>
          {branches.isPending || branches.isFetching ? (
            <p role="status">{t('gitLoading')}</p>
          ) : branches.isError ? (
            <p role="alert">{t('gitGithubError')}</p>
          ) : !branches.data?.supported ? (
            <p>{t('gitProviderUnsupported')}</p>
          ) : (
            <div className="space-y-2">
              <label
                className="block text-sm"
                htmlFor={`integrate-branch-${copyId}`}
              >
                {t('gitIntegrateSource')}
              </label>
              <select
                id={`integrate-branch-${copyId}`}
                className="w-full min-w-0 rounded-md border border-input bg-background p-2 text-sm"
                value={selected?.name ?? ''}
                disabled={action.isPending}
                onChange={(event) => {
                  const item = branches.data.items.find(
                    (b) => b.name === event.target.value,
                  );
                  setSelected(
                    item ? { name: item.name, revision: item.revision } : null,
                  );
                  action.reset();
                }}
              >
                <option value="" disabled>
                  {t('gitIntegrateChoose')}
                </option>
                {branches.data.items.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
              {selected && (
                <p className="break-all font-mono text-xs">
                  {selected.revision}
                </p>
              )}
              {branches.data.limited && (
                <p className="text-muted-foreground">
                  {t('gitIntegrateLimited')}
                </p>
              )}
            </div>
          )}
          <ActionError error={action.error} />
          {stale && selected && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('gitIntegrateReviewAgain')}
            </p>
          )}
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
                stale ||
                !selected ||
                branches.isFetching ||
                branches.isError ||
                !branches.data?.supported
              }
              onClick={() => {
                if (!submitted.current) {
                  submitted.current = true;
                  action.mutate();
                }
              }}
            >
              {action.isPending
                ? t('gitIntegratePending')
                : t('gitIntegrateConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
