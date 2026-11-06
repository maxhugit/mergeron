import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { gitGet, gitPath, type GitPullRequests } from '@/lib/workspace-git-api';
import { projectsApi } from '@/lib/projects-api';

export function GitPrAgentPicker({
  projectId,
  resourceId,
  number,
}: {
  projectId: string;
  resourceId: string;
  number: number;
}) {
  const { t } = useTranslation('workspaces');
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const agents = useQuery({
    queryKey: ['workspace-git-pr-agents', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<{ agents: { threadId: string; name: string }[] }>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/pr-agents`,
        signal,
      ),
    enabled: open,
    retry: false,
    staleTime: 0,
  });
  const assign = useMutation({
    mutationFn: (threadId: string) =>
      projectsApi<NonNullable<GitPullRequests['items'][number]['tracking']>>(
        gitPath(
          projectId,
          `resources/${encodeURIComponent(resourceId)}/pull-requests/${number}/agent`,
        ),
        { method: 'POST', body: JSON.stringify({ threadId }) },
      ),
    onSuccess: (tracking) => {
      client.setQueryData<GitPullRequests>(
        ['workspace-git-prs', projectId, resourceId],
        (old) =>
          old && {
            ...old,
            items: old.items.map((pr) =>
              pr.number === number ? { ...pr, tracking } : pr,
            ),
          },
      );
      setOpen(false);
    },
    onError: () => {
      void client.invalidateQueries({
        queryKey: ['workspace-git-prs', projectId, resourceId],
      });
    },
  });
  return (
    <>
      <button
        type="button"
        className="cursor-pointer text-muted-foreground underline underline-offset-2"
        onClick={() => {
          assign.reset();
          setOpen(true);
        }}
      >
        {t('gitPrNoAgent')}
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!assign.isPending) setOpen(next);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('gitPrAssignAgent')}</DialogTitle>
            <DialogDescription>
              {t('gitPrAssignDescription', { number })}
            </DialogDescription>
          </DialogHeader>
          {agents.isPending ? (
            <p role="status">{t('gitLoading')}</p>
          ) : agents.isError ? (
            <div role="alert">
              <p>{t('gitPrAgentsError')}</p>
              <Button variant="outline" onClick={() => void agents.refetch()}>
                {t('gitRefresh')}
              </Button>
            </div>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {agents.data.agents.length === 0 && (
                <p>{t('gitPrAgentsEmpty')}</p>
              )}
              {agents.data.agents.map((agent) => (
                <Button
                  key={agent.threadId}
                  variant="outline"
                  className="h-auto w-full justify-start whitespace-normal break-words py-3 text-left"
                  disabled={assign.isPending}
                  onClick={() => assign.mutate(agent.threadId)}
                >
                  <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{agent.name}</span>
                </Button>
              ))}
            </div>
          )}
          {assign.isPending && <p role="status">{t('gitPrAssigning')}</p>}
          {assign.isError && (
            <p role="alert" className="text-destructive">
              {t('gitPrAssignError')}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
