import { useEffect, useState } from 'react';
import { Package, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useDeliverableBoards } from '@/hooks/use-deliverable-directory-aliases';
import {
  DeliverableRowActions,
  ProjectDeliverablesManager,
  type DetailTab,
} from '@/components/projects/project-deliverables-manager';
import { FileTree } from '@/components/files/file-tree';
import { FileBrowserContext } from '@/components/files/file-browser-context';
import { createFilesStore } from '@/stores/files-store';
import { ProjectTaskManager } from '@/components/projects/project-task-manager';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { projectsApi, type ProjectSummary } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import { showSnackbar } from '@/stores/snackbar-store';

/** Business inventory and the existing document-aware file tree share the same backend. */
export function ExplorerDeliverables({
  project,
  agentThreadId,
  onFile,
  onReference,
  pending,
  revealPath,
}: {
  revealPath?: string | null;
  project: ProjectSummary;
  agentThreadId?: string;
  onFile: (path: string) => void;
  onReference?: (path: string) => void;
  pending: boolean;
}) {
  const boards = useDeliverableBoards(project);
  const session = usePlatformSession();
  const [store] = useState(createFilesStore);
  const client = useQueryClient();
  const { t } = useTranslation('deliverables');
  const { t: common } = useTranslation();
  const [opened, setOpened] = useState<{
    id: string | null;
    revealPath?: string | null;
  }>({ id: null });
  const [details, setDetails] = useState<{
    id: string;
    resourceId: string;
    tab?: DetailTab;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    id: string;
    resourceId: string;
    title: string;
  } | null>(null);
  const [deletingPending, setDeletingPending] = useState(false);
  const [task, setTask] = useState<{ id: string; resourceId: string } | null>(
    null,
  );
  const revealedItem = boards
    .flatMap((board) => board.data?.deliverables ?? [])
    .find(
      (item) =>
        revealPath === item.directory ||
        revealPath?.startsWith(item.directory + '/'),
    );
  const revealedId = revealedItem?.id;
  const openedId =
    opened.revealPath !== revealPath && revealedId ? revealedId : opened.id;
  useEffect(() => {
    if (revealedId && revealPath) {
      store.getState().setRootDir(revealPath);
    }
  }, [revealedId, revealPath, store]);
  return (
    <FileBrowserContext.Provider value={store}>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {boards.some((q) => q.isLoading) && (
          <Loader2
            className="m-3 h-4 w-4 animate-spin"
            aria-label={t('explorerLoading')}
          />
        )}
        {boards.some((q) => q.isError) && (
          <p role="alert" className="p-2 text-xs text-destructive">
            {t('explorerLoadFailed')}
          </p>
        )}
        {boards.every((q) => !q.isLoading && !q.isError) &&
          !boards.some((q) => q.data?.deliverables.length) && (
            <p className="p-2 text-xs text-muted-foreground">
              {t('explorerEmpty')}
            </p>
          )}
        {boards.flatMap((board) =>
          (board.data?.deliverables ?? []).map((item) => (
            <section key={item.id} className="mb-2 rounded-lg border">
              <div
                className="flex items-center gap-2 p-2"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.currentTarget
                    .querySelector<HTMLButtonElement>(
                      '[data-deliverable-actions] button',
                    )
                    ?.click();
                }}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                  aria-expanded={openedId === item.id}
                  onClick={() => {
                    setOpened({
                      id: openedId === item.id ? null : item.id,
                      revealPath,
                    });
                    store.getState().setRootDir(item.directory);
                  }}
                >
                  <Package className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {item.title}
                    </span>
                    <span className="text-muted-foreground">
                      {
                        item.documents.filter((d) => d.deletedAt === null)
                          .length
                      }{' '}
                      {t('explorerDocuments')}
                    </span>
                  </span>
                  {openedId === item.id ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>
                <span data-deliverable-actions>
                  <DeliverableRowActions
                    item={item}
                    isAdministrator={session.isAdministrator}
                    onSelect={(_, tab) =>
                      setDetails({
                        id: item.id,
                        resourceId: board.data!.resource.id,
                        tab,
                      })
                    }
                    onReference={
                      onReference && !pending
                        ? () => onReference(item.directory)
                        : undefined
                    }
                    onTask={
                      board.data?.tasks.find(
                        (task) => task.id === item.primaryTaskId,
                      )
                        ? () => {
                            const task = board.data!.tasks.find(
                              (task) => task.id === item.primaryTaskId,
                            )!;
                            setTask({
                              id: task.id,
                              resourceId: task.resourceId,
                            });
                          }
                        : undefined
                    }
                    onDelete={() =>
                      setDeleting({
                        id: item.id,
                        resourceId: board.data!.resource.id,
                        title: item.title,
                      })
                    }
                  />
                </span>
              </div>
              {openedId === item.id && (
                <div className="flex min-h-48 flex-col border-t">
                  <FileTree
                    agentThreadId={agentThreadId}
                    personId={session.data?.personId}
                    project={project}
                    workspaceRoot={{ path: item.directory, name: item.title }}
                    onFileClick={onFile}
                  />
                </div>
              )}
            </section>
          )),
        )}
        <AlertDialog
          open={!!deleting}
          onOpenChange={(open) => {
            if (!open && !deletingPending) setDeleting(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>{common('delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('explorerDeleteConfirm', { name: deleting?.title })}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deletingPending}>
                {common('cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={deletingPending}
                onClick={async (e) => {
                  e.preventDefault();
                  if (!deleting) return;
                  setDeletingPending(true);
                  try {
                    await projectsApi(
                      `/${project.id}/resources/${deleting.resourceId}/deliverables/${deleting.id}`,
                      { method: 'DELETE' },
                    );
                    await client.invalidateQueries({
                      queryKey: ['project-deliverables'],
                    });
                    setDeleting(null);
                  } catch {
                    showSnackbar(t('explorerDeleteFailed'), 'error');
                  } finally {
                    setDeletingPending(false);
                  }
                }}
              >
                {common('delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {task && (
          <ProjectTaskManager
            projectId={project.id}
            resourceId={task.resourceId}
            initialTaskId={task.id}
            modalOnly
            onModalClose={() => setTask(null)}
          />
        )}
        {details && (
          <ProjectDeliverablesManager
            projectId={project.id}
            resourceId={details.resourceId}
            initialDeliverableId={details.id}
            initialTab={details.tab}
            modalOnly
            onModalClose={() => setDetails(null)}
          />
        )}
      </div>
    </FileBrowserContext.Provider>
  );
}
