import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { projectsApi, projectsQueryKey } from '@/lib/projects-api';
import {
  gitPath,
  gitInventoryKey,
  type GitSnapshot,
} from '@/lib/workspace-git-api';
import { ActionError } from './workspace-git-actions';

export function GitCreateBranch({
  projectId,
  copyId,
  snapshot,
  agentThreadId,
  readOnly,
}: {
  projectId: string;
  copyId: string;
  snapshot: GitSnapshot;
  agentThreadId?: string;
  readOnly: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [reviewed, setReviewed] = useState<GitSnapshot | null>(null);
  const [name, setName] = useState('');
  const [startRef, setStartRef] = useState('HEAD');
  const [checkout, setCheckout] = useState(false);
  const [result, setResult] = useState('');
  const startRevision =
    startRef === 'HEAD'
      ? reviewed?.head
      : reviewed?.branches.find(
          (branch) =>
            `${branch.remote ? 'refs/remotes/' : 'refs/heads/'}${branch.name}` ===
            startRef,
        )?.revision;
  const create = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi(
        gitPath(projectId, `copies/${encodeURIComponent(copyId)}/branches`),
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            startRef,
            startRevision,
            checkout,
            fingerprint: reviewed?.fingerprint,
            agentThreadId,
            confirmation: 'CREATE_LOCAL_BRANCH',
          }),
        },
      ),
    onSuccess: async () => {
      setResult(
        t(checkout ? 'gitBranchCreatedSwitched' : 'gitBranchCreated', {
          name: name.trim(),
        }),
      );
      setReviewed(null);
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['workspace-git', projectId, copyId],
        }),
        client.invalidateQueries({
          queryKey: ['workspace-git-graph', projectId, copyId],
        }),
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
      ]);
    },
  });
  return (
    <div className="mb-3 space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={readOnly || !snapshot.fingerprint || !snapshot.head}
        onClick={() => {
          create.reset();
          setName('');
          setStartRef('HEAD');
          setCheckout(false);
          setResult('');
          setReviewed(snapshot);
        }}
      >
        {t('gitCreateBranch')}
      </Button>
      {result && <p role="status">{result}</p>}
      <Dialog
        open={Boolean(reviewed)}
        onOpenChange={(open) => {
          if (!open && !create.isPending) setReviewed(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('gitCreateBranch')}</DialogTitle>
            <DialogDescription>{t('gitCreateBranchHelp')}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && startRevision && !create.isPending)
                create.mutate();
            }}
          >
            <label className="grid gap-1 text-sm">
              {t('gitBranchName')}
              <input
                autoComplete="off"
                maxLength={200}
                required
                disabled={create.isPending}
                className="w-full rounded-md border bg-background p-2"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              {t('gitBranchStart')}
              <select
                disabled={create.isPending}
                className="w-full min-w-0 rounded-md border bg-background p-2"
                value={startRef}
                onChange={(event) => setStartRef(event.target.value)}
              >
                <option value="HEAD">
                  {t('gitBranchCurrentHead', {
                    branch: reviewed?.branch ?? 'HEAD',
                    sha: reviewed?.head.slice(0, 7),
                  })}
                </option>
                {reviewed?.branches
                  .filter((branch) => branch.revision)
                  .map((branch) => {
                    const ref = `${branch.remote ? 'refs/remotes/' : 'refs/heads/'}${branch.name}`;
                    return (
                      <option key={ref} value={ref}>
                        {branch.name} · {branch.revision.slice(0, 7)}
                      </option>
                    );
                  })}
              </select>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                disabled={create.isPending}
                checked={checkout}
                onChange={(event) => setCheckout(event.target.checked)}
              />
              {t('gitBranchSwitch')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('gitBranchSwitchHelp')}
            </p>
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
                disabled={!name.trim() || !startRevision || create.isPending}
              >
                {t('gitCreateBranch')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
