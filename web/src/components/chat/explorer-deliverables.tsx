import { useDeliverableGitStatus } from '@/hooks/use-deliverable-git-status';
import {
  DeliverableGitBanner,
  DeliverableGitBadge,
} from './explorer-deliverable-git-status';
import { useAgentDocumentView } from '@/hooks/use-agent-document-view';
import { useSidebarPreferences } from '@/hooks/use-sidebar-preferences';
import { Button } from '@/components/ui/button';
import { lazy, Suspense, useState } from 'react';
import {
  Package,
  PackagePlus,
  List,
  Tags,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useDeliverableBoards } from '@/hooks/use-deliverable-directory-aliases';
import {
  DeliverableRowActions,
  ProjectDeliverablesManager,
  type DetailTab,
} from '@/components/projects/project-deliverables-manager';
import { ExplorerDeliverableDocuments } from './explorer-deliverable-documents';
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
const DocumentGitDialog = lazy(() =>
  import('./document-git-dialog').then((module) => ({
    default: module.DocumentGitDialog,
  })),
);

/** Deliverable inventory with versioned document actions, independent from the file explorer. */
export function ExplorerDeliverables({
  project,
  agentThreadId,
  preferredGitResourceId,
  onFile,
  onReference,
  pending,
  revealPath,
  revealRequestId = 0,
}: {
  revealRequestId?: number;
  revealPath?: string | null;
  project: ProjectSummary;
  agentThreadId?: string;
  preferredGitResourceId?: string | null;
  onFile: (path: string) => void;
  onReference?: (path: string) => void;
  pending: boolean;
}) {
  const boards = useDeliverableBoards(project);
  const sync = useDeliverableGitStatus(
    project.id,
    agentThreadId,
    preferredGitResourceId,
    JSON.stringify(
      boards.flatMap(
        (board) =>
          board.data?.deliverables.map((item) => [
            item.id,
            item.version,
            item.title,
            item.description,
            item.documents.map((doc) => [
              doc.id,
              doc.name,
              doc.currentVersionNumber,
              doc.deletedAt,
            ]),
          ]) ?? [],
      ),
    ),
  );
  const session = usePlatformSession();
  const repairScope = JSON.stringify([project.id, agentThreadId]);
  const [repair, setRepair] = useState<{
    scope: string;
    documentId: string;
    name: string;
  } | null>(null);
  const client = useQueryClient();
  const { t } = useTranslation('deliverables');
  const { t: common } = useTranslation();
  const { t: work } = useTranslation('workspaces');
  const preference = useAgentDocumentView(
    session.data?.personId,
    agentThreadId,
  );
  const disclosure = useSidebarPreferences(
    session.data?.personId,
    agentThreadId,
  );
  const [creating, setCreating] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [opened, setOpened] = useState<{
    id: string | null;
    revealPath?: string | null;
    revealRequestId?: number;
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
  const isOpened = (id: string) =>
    ((opened.revealPath !== revealPath ||
      opened.revealRequestId !== revealRequestId) &&
      revealedId === id) ||
    disclosure.values[`open:deliverable:${id}`] === true ||
    (!(session.data?.personId && agentThreadId) && opened.id === id);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {repair?.scope === repairScope && (
        <Suspense fallback={null}>
          <DocumentGitDialog
            key={`${repairScope}:${sync.selectedId}`}
            projectId={project.id}
            documentId={repair.documentId}
            name={repair.name}
            options={
              sync.selectedId && sync.data?.boards[0]?.settings
                ? {
                    boardId: sync.data.boards[0].id,
                    copyId: sync.selectedId,
                    directory:
                      sync.copy?.directory ??
                      sync.data.boards[0].settings.directory,
                    restrictedIds: sync.data.boards[0].settings.restrictedIds,
                  }
                : undefined
            }
            onClose={() => setRepair(null)}
            onFile={(path) => {
              onFile(path);
              setRepair(null);
            }}
            onDone={() => {
              setRepair(null);
              sync.refresh();
              void client.invalidateQueries({
                queryKey: ['project-deliverables'],
              });
              void client.invalidateQueries({ queryKey: ['deliverables'] });
              showSnackbar(work('gitDocumentResolved'), 'info');
            }}
          />
        </Suspense>
      )}
      <DeliverableGitBanner
        sync={sync}
        projectId={project.id}
        canManage={session.isAdministrator}
      >
        {session.isAdministrator && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            aria-label={work('sidebarNewDeliverable')}
            title={work('sidebarNewDeliverable')}
            disabled={!boards.some((b) => b.data)}
            onClick={() =>
              setCreating(boards.find((b) => b.data)?.data?.resource.id ?? null)
            }
          >
            <PackagePlus className="h-4 w-4" />
          </Button>
        )}
        <div
          className="flex shrink-0 items-center border-l pl-1"
          role="group"
          aria-label={t('labelsExplorerDisplay')}
        >
          {(['plain', 'labels'] as const).map((value) => {
            const Icon = value === 'plain' ? List : Tags;
            const label = t(
              value === 'plain'
                ? 'labelsExplorerPlain'
                : 'labelsExplorerVirtual',
            );
            return (
              <Button
                key={value}
                size="icon"
                variant={preference.mode === value ? 'secondary' : 'ghost'}
                className="h-8 w-8"
                aria-label={label}
                title={label}
                aria-pressed={preference.mode === value}
                disabled={!preference.available || preference.loading}
                onClick={() => preference.setMode(value)}
              >
                <Icon className="h-4 w-4" />
              </Button>
            );
          })}
        </div>
      </DeliverableGitBanner>
      {(disclosure.error || preference.error) && (
        <p role="alert" className="p-2 text-xs text-destructive">
          {work('sidebarPreferenceError')}
        </p>
      )}
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
                  aria-expanded={isOpened(item.id)}
                  disabled={
                    !!session.data?.personId &&
                    !!agentThreadId &&
                    (!disclosure.ready || disclosure.pending)
                  }
                  onClick={() => {
                    if (disclosure.ready && !disclosure.pending)
                      disclosure.set(
                        `open:deliverable:${item.id}`,
                        !isOpened(item.id),
                      );
                    setOpened({
                      id: isOpened(item.id) ? null : item.id,
                      revealPath:
                        item.id === revealedId ? revealPath : opened.revealPath,
                      revealRequestId:
                        item.id === revealedId
                          ? revealRequestId
                          : opened.revealRequestId,
                    });
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
                  {isOpened(item.id) ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>
                <DeliverableGitBadge sync={sync} itemId={item.id} />
                <span data-deliverable-actions>
                  <DeliverableRowActions
                    item={item}
                    isAdministrator={session.isAdministrator}
                    assignmentLabel={work(
                      item.conversations?.some(
                        (link) =>
                          link.type === 'agent' && link.id === agentThreadId,
                      )
                        ? 'sidebarUnassign'
                        : 'assignCurrentAgent',
                    )}
                    onAssign={
                      agentThreadId && session.isAdministrator && !assigning
                        ? async () => {
                            setAssigning(true);
                            try {
                              const linked = item.conversations?.some(
                                (link) =>
                                  link.type === 'agent' &&
                                  link.id === agentThreadId,
                              );
                              await projectsApi(
                                `/${project.id}/resources/${board.data!.resource.id}/deliverables/${item.id}${linked ? '' : '/assignment'}`,
                                {
                                  method: linked ? 'PATCH' : 'POST',
                                  body: JSON.stringify(
                                    linked
                                      ? {
                                          version: item.version,
                                          conversations:
                                            item.conversations.filter(
                                              (link) =>
                                                !(
                                                  link.type === 'agent' &&
                                                  link.id === agentThreadId
                                                ),
                                            ),
                                        }
                                      : {
                                          threadId: agentThreadId,
                                          version: item.version,
                                        },
                                  ),
                                },
                              );
                              await Promise.all([
                                client.invalidateQueries({
                                  queryKey: ['project-deliverables'],
                                }),
                                client.invalidateQueries({
                                  queryKey: ['projects'],
                                }),
                              ]);
                            } catch {
                              showSnackbar(
                                work('sidebarAssignmentError'),
                                'error',
                              );
                            } finally {
                              setAssigning(false);
                            }
                          }
                        : undefined
                    }
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
              {isOpened(item.id) && (
                <div className="min-w-0 border-t">
                  <ExplorerDeliverableDocuments
                    onSynchronize={(document) =>
                      setRepair({
                        scope: repairScope,
                        documentId: document.id,
                        name: document.name,
                      })
                    }
                    documentState={(document) =>
                      sync.documentState(item.id, document.id, document.name)
                    }
                    hideDisplayControl
                    item={item}
                    base={`/${project.id}/resources/${board.data!.resource.id}/deliverables`}
                    agentThreadId={agentThreadId}
                    personId={session.data?.personId}
                    onFile={onFile}
                    refresh={() =>
                      client.invalidateQueries({
                        queryKey: ['project-deliverables'],
                      })
                    }
                  />
                </div>
              )}
            </section>
          )),
        )}
      </div>
      {creating && (
        <ProjectDeliverablesManager
          projectId={project.id}
          resourceId={creating}
          initialCreate
          modalOnly
          onModalClose={() => setCreating(null)}
        />
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
  );
}
