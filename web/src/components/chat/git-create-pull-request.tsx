import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import {
  gitGet,
  gitPath,
  type GitRemoteBranches,
  type GitSnapshot,
} from '@/lib/workspace-git-api';
import { ActionError } from './workspace-git-actions';

export function GitCreatePullRequest({
  projectId,
  copyId,
  resourceId,
  snapshot,
  published,
  agentThreadId,
}: {
  projectId: string;
  copyId: string;
  resourceId: string;
  snapshot: GitSnapshot;
  agentThreadId?: string;
  published: { sha: string; branch: string; address: string };
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [reviewed, setReviewed] = useState<GitSnapshot | null>(null);
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState(false);
  const [result, setResult] = useState<{
    number: number;
    url: string;
    existing: boolean;
  } | null>(null);
  const submitted = useRef(false);
  const branches = useQuery({
    queryKey: ['workspace-git-remote-branches', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<GitRemoteBranches>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/branches`,
        signal,
      ),
    enabled: Boolean(reviewed),
    retry: false,
    staleTime: 0,
  });
  const create = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi<{ number: number; url: string; existing: boolean }>(
        gitPath(
          projectId,
          `copies/${encodeURIComponent(copyId)}/pull-requests`,
        ),
        {
          method: 'POST',
          body: JSON.stringify({
            confirmation: 'CREATE_PULL_REQUEST',
            fingerprint: reviewed?.fingerprint,
            head: published.sha,
            address: published.address,
            agentThreadId,
            base,
            title: title.trim(),
            description,
            draft,
          }),
        },
      ),
    onSuccess: async (value) => {
      setResult(value);
      setReviewed(null);
      await client.invalidateQueries({
        queryKey: ['workspace-git-prs', projectId, resourceId],
      });
    },
    onSettled: () => {
      submitted.current = false;
    },
  });
  const stale =
    snapshot.head !== published.sha || snapshot.branch !== published.branch;
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={stale || !snapshot.fingerprint}
        onClick={() => {
          create.reset();
          setReviewed(snapshot);
          setBase('');
          setTitle(published.branch);
          setDescription('');
          setDraft(false);
          setResult(null);
        }}
      >
        {t('gitCreatePr')}
      </Button>
      {stale && (
        <p className="text-xs text-muted-foreground">
          {t('gitPrPushRequired')}
        </p>
      )}
      {result && (
        <p role="status" className="text-xs">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {t(result.existing ? 'gitPrExisting' : 'gitPrCreated', {
              number: result.number,
            })}
          </a>
        </p>
      )}
      <Dialog
        open={Boolean(reviewed)}
        onOpenChange={(open) => {
          if (!open && !submitted.current) setReviewed(null);
        }}
      >
        <DialogContent
          showCloseButton={!create.isPending}
          className="max-h-[85dvh] overflow-auto sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>{t('gitCreatePr')}</DialogTitle>
            <DialogDescription>{t('gitCreatePrHelp')}</DialogDescription>
          </DialogHeader>
          <p className="break-all text-xs text-muted-foreground">
            {published.address}
            <br />
            {published.branch} · {published.sha.slice(0, 7)}
          </p>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                submitted.current ||
                stale ||
                !base ||
                !title.trim() ||
                !branches.data?.items.some((branch) => branch.name === base)
              )
                return;
              submitted.current = true;
              create.mutate();
            }}
          >
            <label className="grid gap-1 text-sm">
              {t('gitPrBase')}
              <select
                required
                disabled={create.isPending || branches.isFetching}
                value={base}
                onChange={(event) => setBase(event.target.value)}
                className="w-full min-w-0 rounded-md border bg-background p-2"
              >
                <option value="">{t('gitPrSelectBase')}</option>
                {branches.data?.items
                  .filter((branch) => branch.name !== published.branch)
                  .map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            </label>
            {branches.isError && (
              <p role="alert" className="text-xs text-destructive">
                {t('gitPrBranchesFailed')}
              </p>
            )}
            {branches.data?.limited && (
              <p className="text-xs text-muted-foreground">{t('gitLimited')}</p>
            )}
            <label className="grid gap-1 text-sm">
              {t('gitPrTitle')}
              <input
                required
                maxLength={256}
                disabled={create.isPending}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="w-full rounded-md border bg-background p-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              {t('gitPrDescription')}
              <textarea
                maxLength={60000}
                rows={4}
                disabled={create.isPending}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="w-full rounded-md border bg-background p-2"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={create.isPending}
                checked={draft}
                onChange={(event) => setDraft(event.target.checked)}
              />
              {t('gitPrDraft')}
            </label>
            <ActionError error={create.error} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => setReviewed(null)}
              >
                {t('cancel', { ns: 'common' })}
              </Button>
              <Button
                disabled={
                  create.isPending ||
                  stale ||
                  branches.isFetching ||
                  branches.isError ||
                  !base ||
                  !title.trim() ||
                  !branches.data?.items.some((branch) => branch.name === base)
                }
              >
                {t('gitCreatePr')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
