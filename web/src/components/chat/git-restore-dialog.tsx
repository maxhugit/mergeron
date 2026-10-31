import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CloudDownload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import {
  gitGet,
  gitPath,
  type GitSnapshot,
  type GitRemoteBranches,
} from '@/lib/workspace-git-api';
import { ActionError } from './workspace-git-actions';

interface Review {
  branch: string;
  head: string;
  revision: string;
  reviewFingerprint: string;
  paths: string[];
  fileCount: number;
  limited: boolean;
  localCommits: number;
  preservedUntracked: number;
}
interface Result {
  restored: boolean;
  backupBranch: string;
  backupRevision: string;
  reason?: string;
}
interface Props {
  projectId: string;
  copyId: string;
  snapshot: GitSnapshot;
  agentThreadId?: string;
  address?: string | null;
  resourceId?: string;
  target: 'head' | 'github';
  paths?: string[];
  onClose: () => void;
}

/** Mount only when requested, so the review always starts from a frozen state. */
export function GitRestoreDialog({
  projectId,
  copyId,
  snapshot,
  agentThreadId,
  address,
  resourceId,
  target,
  paths,
  onClose,
}: Props) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [base] = useState(() => ({
    fingerprint: snapshot.fingerprint,
    branch: snapshot.branch,
  }));
  const [chosen, setChosen] = useState<{
    name: string;
    revision: string;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const submitted = useRef(false);
  const review = useMutation({
    retry: false,
    mutationFn: async () => {
      const input = {
        fingerprint: base.fingerprint,
        agentThreadId,
        target,
        ...(target === 'head'
          ? { paths }
          : { name: chosen?.name, revision: chosen?.revision, address }),
      };
      const data = await projectsApi<Review>(
        gitPath(
          projectId,
          `copies/${encodeURIComponent(copyId)}/restore-review`,
        ),
        { method: 'POST', body: JSON.stringify(input) },
      );
      return { input, data };
    },
  });
  const restore = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi<Result>(
        gitPath(projectId, `copies/${encodeURIComponent(copyId)}/restore`),
        {
          method: 'POST',
          body: JSON.stringify({
            ...review.data!.input,
            reviewFingerprint: review.data!.data.reviewFingerprint,
            confirmation:
              target === 'head'
                ? 'RESTORE_LOCAL_FILES'
                : 'RESTORE_GITHUB_STATE',
          }),
        },
      ),
    onSettled: async () => {
      await Promise.all([
        ...[
          'workspace-git',
          'workspace-git-staged',
          'workspace-git-commits',
          'workspace-git-graph',
        ].map((key) =>
          client.invalidateQueries({ queryKey: [key, projectId, copyId] }),
        ),
        client.invalidateQueries({ queryKey: [{ _id: 'filesReadTree' }] }),
        client.invalidateQueries({ queryKey: [{ _id: 'filesReadFile' }] }),
      ]);
    },
  });
  const plan = review.data?.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !restore.isPending && !review.isPending) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] min-w-0 flex-col overflow-auto [--glass-modal-surface:var(--popover)] sm:max-w-xl"
        showCloseButton={!restore.isPending && !review.isPending}
        onInteractOutside={(event) => {
          if (restore.isPending || review.isPending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(target === 'head' ? 'gitRestoreFiles' : 'gitRestoreGithubTitle')}
          </DialogTitle>
          <DialogDescription>
            {t(
              target === 'head'
                ? 'gitRestoreFilesHelp'
                : 'gitRestoreGithubHelp',
            )}
          </DialogDescription>
        </DialogHeader>
        {restore.data ? (
          <>
            <p
              role={restore.data.restored ? 'status' : 'alert'}
              className="text-sm"
            >
              {t(
                restore.data.restored
                  ? 'gitRestoreDone'
                  : 'gitRestoreIncomplete',
              )}
            </p>
            <p className="text-sm">
              {t('gitRestoreBackup')}{' '}
              <code className="break-all">{restore.data.backupBranch}</code>
            </p>
            <p className="text-xs text-muted-foreground">
              {t('gitRestoreRecoveryHelp')}
            </p>
          </>
        ) : (
          <>
            {target === 'github' && resourceId && (
              <GitRestoreBranchChoice
                projectId={projectId}
                resourceId={resourceId}
                branch={base.branch}
                disabled={review.isPending || Boolean(plan)}
                onSelect={setChosen}
              />
            )}
            {!plan && (
              <>
                {target === 'head' && (
                  <ul className="max-h-40 overflow-auto text-sm">
                    {paths?.map((name) => (
                      <li className="break-all" key={name}>
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  variant="outline"
                  disabled={
                    review.isPending || (target === 'github' && !chosen)
                  }
                  onClick={() => review.mutate()}
                >
                  {t(review.isPending ? 'gitLoading' : 'gitRestoreReview')}
                </Button>
              </>
            )}
            {plan && (
              <>
                <p className="break-all text-sm">
                  {t('gitRestoreTarget', {
                    branch: plan.branch,
                    revision: plan.revision.slice(0, 12),
                  })}
                </p>
                <p className="text-sm">
                  {t('gitRestoreAffected', { count: plan.fileCount })}
                </p>
                <ul className="max-h-40 overflow-auto rounded border p-2 text-xs">
                  {plan.paths.map((name) => (
                    <li className="break-all" key={name}>
                      {name}
                    </li>
                  ))}
                </ul>
                {plan.limited && <p className="text-xs">{t('gitLimited')}</p>}
                {target === 'github' && (
                  <p className="text-sm">
                    {t('gitRestoreLocalCommits', { count: plan.localCommits })}
                  </p>
                )}
                <p className="rounded border border-destructive/40 p-3 text-sm">
                  {t('gitRestoreWarning')}
                </p>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={confirmed}
                    disabled={restore.isPending}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {t('gitRestoreAcknowledge')}
                </label>
              </>
            )}
            <ActionError error={review.error ?? restore.error} />
          </>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={review.isPending || restore.isPending}
            onClick={onClose}
          >
            {t(restore.data ? 'gitRestoreClose' : 'gitActionCancel')}
          </Button>
          {plan && !restore.data && (
            <Button
              variant="destructive"
              disabled={!confirmed || restore.isPending || attempted}
              onClick={() => {
                if (!submitted.current) {
                  submitted.current = true;
                  setAttempted(true);
                  restore.mutate();
                }
              }}
            >
              {t(restore.isPending ? 'gitLoading' : 'gitRestoreConfirm')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Resolve branches through the existing registered inventory, never user URLs. */
function GitRestoreBranchChoice({
  projectId,
  resourceId,
  branch,
  disabled,
  onSelect,
}: {
  projectId: string;
  resourceId: string;
  branch: string | null;
  disabled: boolean;
  onSelect: (value: { name: string; revision: string } | null) => void;
}) {
  const { t } = useTranslation('workspaces');
  const [value, setValue] = useState('');
  const branches = useQuery({
    queryKey: ['workspace-git-restore-choice', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<GitRemoteBranches>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/branches`,
        signal,
      ),
    retry: false,
  });
  return (
    <div className="space-y-2">
      <label className="grid min-w-0 gap-1 text-sm">
        {t('gitRestoreSource')}
        <select
          className="min-w-0 rounded-md border bg-background p-2"
          value={value}
          disabled={disabled || !branches.data?.supported}
          onChange={(event) => {
            setValue(event.target.value);
            const chosen = branches.data?.items.find(
              (item) => item.name === event.target.value,
            );
            onSelect(chosen ?? null);
          }}
        >
          <option value="" disabled>
            {t('gitRestoreChoose')}
          </option>
          {branches.data?.items.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.revision.slice(0, 7)}
              {item.name === branch ? ` · ${t('gitCurrent')}` : ''}
            </option>
          ))}
        </select>
      </label>
      {branches.isError && (
        <p role="alert" className="text-sm">
          {t('gitGithubError')}
        </p>
      )}
    </div>
  );
}

export function GitRestoreGithubAction(
  props: Omit<Props, 'target' | 'paths' | 'onClose'> & {
    writable: boolean;
    resourceId: string;
  },
) {
  const { t } = useTranslation('workspaces');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={
          !props.writable ||
          !props.snapshot.head ||
          !props.snapshot.branch ||
          !props.snapshot.fingerprint
        }
        onClick={() => setOpen(true)}
      >
        <CloudDownload className="mr-2 size-4" />
        {t('gitRestoreGithub')}
      </Button>
      {open && (
        <GitRestoreDialog
          {...props}
          target="github"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
