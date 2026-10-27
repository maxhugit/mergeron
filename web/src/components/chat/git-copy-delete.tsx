import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectWorkspaceCopySummary,
} from '@/lib/projects-api';
import { gitInventoryKey } from '@/lib/workspace-git-api';

export function GitCopyDelete({
  projectId,
  copy,
  active = false,
  onRemoved,
  initialOpen = false,
  hideTrigger = false,
}: {
  projectId: string;
  copy: ProjectWorkspaceCopySummary;
  active?: boolean;
  onRemoved?: (path: string) => void;
  initialOpen?: boolean;
  hideTrigger?: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [open, setOpen] = useState(initialOpen && !active);
  const [recovery, setRecovery] = useState('');
  const deletion = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi<{ recoveryPath: string }>(
        `/${encodeURIComponent(projectId)}/workspace-resources/copies/${encodeURIComponent(copy.id)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            confirmation: 'REMOVE_WORKING_COPY',
            path: copy.localPath,
          }),
        },
      ),
    onSuccess: async (result) => {
      setOpen(false);
      setRecovery(result.recoveryPath);
      onRemoved?.(result.recoveryPath);
      await Promise.all([
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
        client.invalidateQueries({
          queryKey: ['project-locations', projectId],
        }),
      ]);
    },
  });
  const errors: Record<string, string> = {
    GIT_COPY_IN_USE: t('gitCopyInUse'),
    GIT_BUSY: t('gitActionBusy'),
    GIT_AGENT_STATE_UNKNOWN: t('gitActionAgentStateUnknown'),
    GIT_STALE: t('gitActionStale'),
    GIT_COPY_PATH_UNSAFE: t('gitCopyDeleteFailed'),
  };
  return (
    <div className="space-y-1">
      {!hideTrigger && (
        <Button
          size="sm"
          variant="outline"
          className="h-auto whitespace-normal text-xs text-destructive"
          disabled={active || !copy.localPath || deletion.isPending}
          onClick={() => {
            deletion.reset();
            setOpen(true);
          }}
        >
          {t('gitCopyDelete')}
        </Button>
      )}
      {active && !hideTrigger && (
        <p className="text-xs text-muted-foreground">{t('gitCopyInUse')}</p>
      )}
      {recovery && (
        <p role="status" className="break-all text-xs">
          {t('gitCopyRecovery', { path: recovery })}
        </p>
      )}
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!deletion.isPending) setOpen(value);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('gitCopyDeleteTitle', { name: copy.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('gitCopyDeleteHelp')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 break-all text-xs">
            <p>{copy.id}</p>
            <p>{copy.localPath}</p>
            <p>{copy.branch ?? t('gitDetached')}</p>
          </div>
          {deletion.error && (
            <p role="alert" className="text-xs text-destructive">
              {errors[deletion.error.message] ?? t('gitCopyDeleteFailed')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletion.isPending}>
              {t('gitCopyDeleteCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              disabled={deletion.isPending || active}
              onClick={(event) => {
                event.preventDefault();
                if (!deletion.isPending) deletion.mutate();
              }}
            >
              {t('gitCopyDeleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
