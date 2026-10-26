import { Bot, Folder, FolderPlus, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ProjectSummary } from '@/lib/projects-api';
import { ExternalWorkspaceResources } from './external-workspace-resources';
import { ProjectLocationsIntro } from '@/components/projects/project-locations-intro';

interface Props {
  project: ProjectSummary | null;
  pending: boolean;
  onClose: () => void;
  onAdd: (project: ProjectSummary) => void;
  onDetach: (project: ProjectSummary, workspaceId: string) => void;
}

/** Centralizes workspace membership without mixing it with project actions. */
export function ManageWorkspacesDialog({
  project,
  pending,
  onClose,
  onAdd,
  onDetach,
}: Props) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => !open && !pending && onClose()}
    >
      {project && (
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('manageWorkspaces')}</DialogTitle>
            <DialogDescription>
              {t(
                'thePrimaryWorkspaceIsPermanentAddOrDetachSecondaryWorkspacesWithoutDeletingThei69867b01',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            <ProjectLocationsIntro />
            {project.workspaces.map((workspace) => {
              const agents = (project.agentThreads ?? []).filter(
                (thread) => thread.workspacePath === workspace.path,
              );
              const conversationCount = agents.length;
              return (
                <div
                  key={workspace.id}
                  className="space-y-3 rounded-lg border border-border p-3"
                >
                  <div className="flex items-center gap-3">
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 font-medium">
                        <span className="truncate">{workspace.name}</span>
                        {workspace.primary && (
                          <Badge variant="secondary">
                            {t('primaryWorkspace')}
                          </Badge>
                        )}
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={workspace.path}
                      >
                        {workspace.path}
                      </div>
                    </div>
                    {!workspace.primary && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={pending}
                          onClick={() => onDetach(project, workspace.id)}
                        >
                          <Unlink className="h-3.5 w-3.5" />
                          {t('detach')}
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="ml-7 space-y-1.5 border-l border-border pl-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('associatedConversations')} ({conversationCount})
                    </div>
                    {conversationCount === 0 ? (
                      <p className="text-xs italic text-muted-foreground">
                        {t('noAssociatedConversation')}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {agents.map((thread) => (
                          <div
                            key={thread.threadId}
                            className="flex min-w-0 items-center gap-2 text-xs"
                          >
                            <Bot className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{thread.title}</span>
                            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                              {t('workAgent')}
                              {thread.archived ? ` · ${t('archived')}` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {!workspace.primary && conversationCount > 0 && (
                      <p className="pt-1 text-[11px] text-muted-foreground">
                        {t(
                          'detachingWillMoveTheseConversationsToThePrimaryWorkspaceTheyWillNotBeDeleted',
                        )}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            <ExternalWorkspaceResources project={project} pending={pending} />
          </div>
          <DialogFooter className="flex-row justify-between sm:justify-between">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => onAdd(project)}
            >
              <FolderPlus className="h-4 w-4" />
              {t('addAWorkspace')}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={onClose}>
              {t('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
