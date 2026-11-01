import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ProjectArchivedAgents } from '@/components/projects/project-archived-agents';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import {
  threadsForkThreadMutation,
  threadsUnarchiveThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { useForkWithGoal } from '@/hooks/use-fork-with-goal';
import { ForkGoalDialog } from '@/components/chat/sidebar/fork-goal-dialog';
import { DeleteConversationDialog } from '@/components/branches/delete-conversation-dialog';
import {
  adoptionBlockReason,
  buildDeleteRequestBody,
  useBranchAdoptionStatus,
  useDeletePreview,
  useDeleteThread,
} from '@/hooks/use-thread-deletion';
import {
  invalidateThreadListSoon,
  invalidateBranchTreesSoon,
  invalidateBranchTreeMembersSoon,
} from '@/lib/query-invalidation';
import { getApiErrorMessage } from '@/lib/api-error';
import { useSnackbarStore } from '@/stores/snackbar-store';
import { Button } from '@/components/ui/button';

/** Standalone authenticated project page, not an agent workspace tab. */
export function ProjectArchivesRoute() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const navigate = useNavigate();
  const { t } = useTranslation();
  const client = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const project = projects.data?.projects.find((item) => item.id === projectId);
  const adoption = useBranchAdoptionStatus();
  const deletePreview = useDeletePreview(deleteTarget);
  const deletion = useDeleteThread({
    onFinished: () => {
      setDeleteTarget(null);
      void client.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
  const refresh = () => {
    invalidateThreadListSoon(client);
    void client.invalidateQueries({ queryKey: projectsQueryKey });
  };
  const error = (err: unknown) =>
    useSnackbarStore.getState().show(getApiErrorMessage(err), 'error');
  const restore = useMutation({
    ...threadsUnarchiveThreadMutation(),
    onSettled: refresh,
    onError: error,
  });
  const forkMutation = useMutation({
    ...threadsForkThreadMutation(),
    onError: error,
    onSuccess: (result, variables) => {
      refresh();
      invalidateBranchTreesSoon(client);
      invalidateBranchTreeMembersSoon(client, [
        variables.path.threadId,
        result.thread.id,
      ]);
      void navigate({
        to: '/t/$threadId',
        params: { threadId: result.thread.id },
      });
    },
  });
  const fork = useForkWithGoal({
    onFork: (threadId, carryGoal) =>
      forkMutation.mutate({ path: { threadId }, body: { carryGoal } }),
  });
  if (projects.isPending)
    return <p className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
  if (projects.isError)
    return (
      <div className="p-6" role="alert">
        <p>{getApiErrorMessage(projects.error)}</p>
        <Button onClick={() => void projects.refetch()}>{t('retry')}</Button>
      </div>
    );
  if (!project)
    return (
      <p className="p-6" role="alert">
        {t('projectNotFound')}
      </p>
    );
  return (
    <>
      <ProjectArchivedAgents
        project={project}
        pending={
          restore.isPending || forkMutation.isPending || deletion.isPending
        }
        deleteBlockedReason={adoptionBlockReason(adoption.data, t)}
        onOpen={(agent) =>
          void navigate({
            to: '/t/$threadId',
            params: { threadId: agent.threadId },
          })
        }
        onRestore={(agent) =>
          restore.mutate({ path: { threadId: agent.threadId } })
        }
        onFork={(agent) => void fork.requestFork(agent.threadId)}
        onDelete={(agent) => setDeleteTarget(agent.threadId)}
        onOpenTask={(agent) => {
          if (agent.taskResourceId && agent.taskId)
            void navigate({
              to: '/projects/$projectId/resources/$resourceId',
              params: { projectId, resourceId: agent.taskResourceId },
              search: { task: agent.taskId },
            });
        }}
      />
      <ForkGoalDialog
        key={fork.prompt?.threadId ?? 'idle'}
        prompt={fork.prompt}
        pending={forkMutation.isPending}
        onConfirm={fork.confirm}
        onCancel={fork.cancel}
      />
      <DeleteConversationDialog
        open={deleteTarget !== null}
        preview={deletePreview.data ?? null}
        loading={deletePreview.isLoading || deletePreview.isFetching}
        errorMessage={
          deletePreview.error ? getApiErrorMessage(deletePreview.error) : null
        }
        pending={deletion.isPending}
        currentThreadId={null}
        onConfirm={(preview) =>
          deletion.mutate({
            path: { threadId: preview.targetThreadId },
            body: buildDeleteRequestBody(preview),
          })
        }
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
