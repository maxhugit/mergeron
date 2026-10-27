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
import {
  projectsApi,
  projectsQueryKey,
  type ProjectWorkspaceCopySummary,
} from '@/lib/projects-api';
import {
  gitInventoryKey,
  gitPath,
  copyOwnedByAgent,
} from '@/lib/workspace-git-api';

export function GitCopyReservation({
  projectId,
  copy,
  agentThreadId,
  active,
  initialOpen = false,
  hideTrigger = false,
}: {
  projectId: string;
  copy: ProjectWorkspaceCopySummary;
  agentThreadId?: string;
  active: boolean;
  initialOpen?: boolean;
  hideTrigger?: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [open, setOpen] = useState(initialOpen && !active);
  const own = copyOwnedByAgent(copy, agentThreadId);
  const release = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi(
        gitPath(
          projectId,
          `copies/${encodeURIComponent(copy.id)}/release-owner`,
        ),
        {
          method: 'POST',
          body: JSON.stringify({
            agentThreadId,
            confirmation: 'RELEASE_COPY_OWNER',
          }),
        },
      ),
    onSuccess: async () => {
      setOpen(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
      ]);
    },
  });
  return (
    <div className="space-y-1">
      {!hideTrigger && (
        <p className="text-muted-foreground">
          {t(
            copy.ownerAgentIds?.length
              ? own
                ? 'gitCopyOwnedByAgent'
                : 'gitCopyOwnedElsewhere'
              : 'gitCopyUnassigned',
          )}
        </p>
      )}
      {own && !hideTrigger && (
        <Button
          size="sm"
          variant="outline"
          disabled={active}
          onClick={() => setOpen(true)}
        >
          {t('gitCopyRelease')}
        </Button>
      )}
      {own && active && !hideTrigger && (
        <p className="text-muted-foreground">{t('gitCopyReleaseActive')}</p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!release.isPending) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('gitCopyRelease')}</DialogTitle>
            <DialogDescription>{t('gitCopyReleaseHelp')}</DialogDescription>
          </DialogHeader>
          {release.isError && <p role="alert">{t('gitCopyReleaseError')}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={release.isPending}
              onClick={() => setOpen(false)}
            >
              {t('gitActionCancel')}
            </Button>
            <Button
              disabled={release.isPending}
              onClick={() => release.mutate()}
            >
              {t('gitCopyRelease')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
