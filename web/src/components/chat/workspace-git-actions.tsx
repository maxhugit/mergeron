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
  gitPath,
  type GitSnapshot,
  type GitChecks,
} from '@/lib/workspace-git-api';

function ActionError({ error }: { error: Error | null }) {
  const { t } = useTranslation('workspaces');
  const labels: Record<string, string> = {
    GIT_COPY_OWNED: t('gitCopyOwnedElsewhere'),
    GIT_AGENT_STATE_UNKNOWN: t('gitActionAgentStateUnknown'),
    GIT_BUSY: t('gitActionBusy'),
    GIT_READ_ONLY: t('gitActionReadOnly'),
    GIT_STALE: t('gitActionStale'),
    GIT_NOTHING_STAGED: t('gitActionNothingStaged'),
    GIT_NO_COMMIT: t('gitNoCommit'),
    GIT_MERGE_BLOCKED: t('gitActionMergeBlocked'),
    GIT_IN_PROGRESS: t('gitActionInProgress'),
    GIT_BRANCH_REQUIRED: t('gitActionBranchRequired'),
    GIT_HTTPS_REQUIRED: t('gitActionHttpsRequired'),
    GIT_GITHUB_TOKEN_REQUIRED: t('gitActionTokenRequired'),
    GIT_IDENTITY_REQUIRED: t('gitActionIdentityRequired'),
    GIT_INVALID_INPUT: t('gitActionInvalidInput'),
    GIT_OUTCOME_UNKNOWN: t('gitActionOutcomeUnknown'),
    GIT_AUTH_REQUIRED: t('gitPushAuthRequired'),
    GIT_WRITE_ACCESS_DENIED: t('gitPushWriteAccessDenied'),
    GIT_REMOTE_REJECTED: t('gitPushRejected'),
    GIT_NETWORK_UNAVAILABLE: t('gitPushNetworkUnavailable'),
    GIT_TLS_ERROR: t('gitPushTlsError'),
  };
  return error ? (
    <p role="alert" className="text-xs text-destructive">
      {labels[error.message] ?? t('gitActionFailed')}
    </p>
  ) : null;
}

export function GitCopyActions({
  projectId,
  copyId,
  snapshot,
  address,
  actionScope = 'all',
  agentThreadId,
}: {
  projectId: string;
  copyId: string;
  snapshot: GitSnapshot;
  address: string | null;
  actionScope?: 'all' | 'commit' | 'push';
  agentThreadId?: string;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [mode, setMode] = useState<'commit' | 'push' | null>(null);
  const [reviewed, setReviewed] = useState<GitSnapshot | null>(null);
  const [reviewAddress, setReviewAddress] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState('');
  const submitted = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const preview = useQuery({
    queryKey: [
      'workspace-git-staged',
      projectId,
      copyId,
      reviewed?.fingerprint,
    ],
    queryFn: ({ signal }) =>
      gitGet<{ fingerprint: string; diff: string }>(
        projectId,
        `copies/${encodeURIComponent(copyId)}/staged-diff`,
        signal,
      ),
    enabled: mode === 'commit',
    retry: false,
  });
  const action = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!reviewed?.fingerprint || !mode) throw new Error('GIT_STALE');
      return projectsApi<{ sha: string }>(
        gitPath(projectId, `copies/${encodeURIComponent(copyId)}/${mode}`),
        {
          method: 'POST',
          body: JSON.stringify({
            fingerprint: reviewed.fingerprint,
            agentThreadId,
            address: reviewAddress,
            ...(mode === 'commit'
              ? { message, authorName: name, authorEmail: email }
              : {}),
          }),
        },
      );
    },
    onSuccess: async (value) => {
      setResult(value.sha.slice(0, 7));
      setMode(null);
      setMessage('');
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
        client.invalidateQueries({
          queryKey: ['workspace-git-remote-branches', projectId],
        }),
      ]);
    },
    onSettled: () => {
      submitted.current = false;
    },
  });
  const open = (value: 'commit' | 'push') => {
    action.reset();
    setResult('');
    setReviewed(snapshot);
    setReviewAddress(address);
    setMode(value);
  };
  const staged =
    reviewed?.changes.filter((item) => ![' ', '?'].includes(item.status[0])) ??
    [];
  const stale =
    mode === 'commit' && preview.data?.fingerprint !== reviewed?.fingerprint;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actionScope !== 'push' && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              !snapshot.fingerprint ||
              !snapshot.branch ||
              !snapshot.changes.some(
                (item) => ![' ', '?'].includes(item.status[0]),
              )
            }
            onClick={(event) => {
              trigger.current = event.currentTarget;
              open('commit');
            }}
          >
            {t('gitActionCommit')}
          </Button>
        )}
        {actionScope !== 'commit' && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              !snapshot.fingerprint || !snapshot.branch || !snapshot.head
            }
            onClick={(event) => {
              trigger.current = event.currentTarget;
              open('push');
            }}
          >
            {actionScope === 'push' ? t('gitPublish') : t('gitActionPush')}
          </Button>
        )}
      </div>
      {actionScope !== 'push' && (
        <p className="text-xs text-muted-foreground">
          {t('gitActionStagedHelp')}
        </p>
      )}
      {result && (
        <p role="status" className="text-xs text-primary">
          {t('gitActionSuccess', { sha: result })}
        </p>
      )}
      <Dialog
        open={mode !== null}
        onOpenChange={(value) => {
          if (!value && !submitted.current) setMode(null);
        }}
      >
        <DialogContent
          showCloseButton={!action.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = trigger.current;
            if (target && !target.disabled) target.focus();
            else
              target?.parentElement
                ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
                ?.focus();
          }}
          className="flex max-h-[85dvh] flex-col overflow-auto sm:max-w-3xl"
        >
          <DialogTitle>
            {t(
              mode === 'push'
                ? 'gitActionConfirmPush'
                : 'gitActionConfirmCommit',
            )}
          </DialogTitle>
          <DialogDescription>
            {t(mode === 'push' ? 'gitActionPushHelp' : 'gitActionCommitHelp')}
          </DialogDescription>
          <p className="break-all text-xs">
            {reviewed?.branch} · {reviewed?.head.slice(0, 7)}
            {mode === 'push' ? ` → ${reviewAddress}` : ''}
          </p>
          {mode === 'commit' && (
            <>
              <ul className="max-h-24 overflow-auto text-xs">
                {staged.map((item) => (
                  <li className="break-all" key={item.path}>
                    {item.status[0]} · {item.path}
                  </li>
                ))}
              </ul>
              {preview.isPending ? (
                <p role="status">{t('gitLoading')}</p>
              ) : preview.error ? (
                <p role="alert">{t('gitDiffError')}</p>
              ) : stale ? (
                <p role="alert">{t('gitActionStale')}</p>
              ) : (
                <pre className="max-h-48 overflow-auto whitespace-pre text-xs">
                  {preview.data?.diff || t('gitNoTextDiff')}
                </pre>
              )}
              <label className="grid gap-1 text-sm">
                {t('gitActionMessage')}
                <textarea
                  className="rounded-md border bg-background p-2"
                  value={message}
                  maxLength={4000}
                  disabled={action.isPending}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  {t('gitActionAuthorName')}
                  <input
                    className="min-w-0 rounded-md border bg-background p-2"
                    value={name}
                    maxLength={120}
                    disabled={action.isPending}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {t('gitActionAuthorEmail')}
                  <input
                    type="email"
                    className="min-w-0 rounded-md border bg-background p-2"
                    value={email}
                    maxLength={254}
                    disabled={action.isPending}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              </div>
            </>
          )}
          <ActionError error={action.error} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => {
                if (!submitted.current) setMode(null);
              }}
            >
              {t('gitActionCancel')}
            </Button>
            <Button
              disabled={
                action.isPending ||
                (mode === 'commit' &&
                  (preview.isPending ||
                    Boolean(preview.error) ||
                    stale ||
                    !message.trim() ||
                    !name.trim() ||
                    !email.trim()))
              }
              onClick={() => {
                if (!submitted.current) {
                  submitted.current = true;
                  action.mutate();
                }
              }}
            >
              {t(
                mode === 'push'
                  ? 'gitActionConfirmPush'
                  : 'gitActionConfirmCommit',
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function GitMergeAction({
  projectId,
  resourceId,
  number,
  checks,
  address,
  onMerged,
  onCloseFocus,
}: {
  projectId: string;
  resourceId: string;
  number: number;
  checks: GitChecks;
  address: string | null;
  onMerged?: () => void;
  onCloseFocus?: () => void;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [review, setReview] = useState<
    (GitChecks & { address: string | null }) | null
  >(null);
  const [done, setDone] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const submitted = useRef(false);
  const allowed =
    checks.baseHead &&
    !checks.draft &&
    checks.mergeable === true &&
    checks.mergeableState === 'clean' &&
    !checks.limited &&
    checks.items.length > 0 &&
    checks.items.every((item) =>
      ['success', 'neutral', 'skipped'].includes(item.status),
    );
  const action = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi(
        gitPath(
          projectId,
          `resources/${encodeURIComponent(resourceId)}/pull-requests/${number}/merge`,
        ),
        {
          method: 'POST',
          body: JSON.stringify({
            head: review?.head,
            baseHead: review?.baseHead,
            address: review?.address,
          }),
        },
      ),
    onSuccess: async () => {
      setReview(null);
      setDone(true);
      onMerged?.();
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['workspace-git-prs', projectId, resourceId],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-checks', projectId, resourceId],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-remote-branches', projectId, resourceId],
        }),
      ]);
    },
    onSettled: () => {
      submitted.current = false;
    },
  });
  return (
    <div className="space-y-2">
      {done ? (
        <p role="status">{t('gitActionMerged')}</p>
      ) : (
        <Button
          ref={trigger}
          size="sm"
          disabled={!allowed}
          onClick={() => {
            action.reset();
            setReview({ ...checks, address });
          }}
        >
          {t('gitActionMerge')}
        </Button>
      )}
      <Dialog
        open={review !== null}
        onOpenChange={(value) => {
          if (!value && !submitted.current) setReview(null);
        }}
      >
        <DialogContent
          showCloseButton={!action.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!done && trigger.current?.isConnected) trigger.current.focus();
            else onCloseFocus?.();
          }}
        >
          <DialogTitle>{t('gitActionConfirmMerge', { number })}</DialogTitle>
          <DialogDescription>{t('gitActionMergeHelp')}</DialogDescription>
          <p className="break-all text-xs">
            {review?.address} · #{number} · {review?.head} → {review?.baseHead}
          </p>
          <ActionError error={action.error} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => {
                if (!submitted.current) setReview(null);
              }}
            >
              {t('gitActionCancel')}
            </Button>
            <Button
              disabled={action.isPending}
              onClick={() => {
                if (!submitted.current) {
                  submitted.current = true;
                  action.mutate();
                }
              }}
            >
              {t('gitActionMerge')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
