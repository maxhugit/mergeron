import { DropdownMenu } from 'radix-ui';
import {
  Archive,
  BookOpen,
  RotateCcw,
  GitBranch,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import type {
  ProjectAgentThreadSummary,
  ProjectSummary,
} from '@/lib/projects-api';
import { workspaceLabel } from '@/components/chat/sidebar/sidebar-types';

export interface ArchivedAgentsProps {
  project: ProjectSummary;
  pending: boolean;
  deleteBlockedReason?: string | null;
  onOpen: (agent: ProjectAgentThreadSummary) => void;
  onRestore: (agent: ProjectAgentThreadSummary) => void;
  onFork: (agent: ProjectAgentThreadSummary) => void;
  onDelete: (agent: ProjectAgentThreadSummary) => void;
  onOpenTask: (agent: ProjectAgentThreadSummary) => void;
}

export function ProjectArchivedAgents({
  project,
  pending,
  deleteBlockedReason,
  onOpen,
  onRestore,
  onFork,
  onDelete,
  onOpenTask,
}: ArchivedAgentsProps) {
  const { t, i18n } = useTranslation();
  const { t: tw } = useTranslation('workspaces');
  const agents = (project.agentThreads ?? []).filter((agent) => agent.archived);
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4"
      aria-label={t('archivedAgents')}
    >
      <header className="shrink-0">
        <h1 className="flex items-center gap-2 text-base font-medium">
          <Archive className="h-4 w-4" />
          {t('archivedAgents')}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {project.name} · {agents.length} · {t('archivedReadOnly')}
        </p>
      </header>
      <div
        className="min-h-0 flex-1 overflow-auto rounded-md border"
        data-archive-table-scroll
      >
        <table
          className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-xs"
          aria-label={tw('archiveTable', { project: project.name })}
        >
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              {[
                tw('archiveConversation'),
                tw('archiveWorkspace'),
                tw('archiveTask'),
                tw('archiveDate'),
                tw('archiveAuthor'),
                t('actions'),
              ].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="border-b bg-background px-3 py-3 font-medium"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const actions = [
                {
                  label: tw('archiveRead'),
                  icon: BookOpen,
                  run: () => onOpen(agent),
                  disabled: false,
                },
                {
                  label: t('unarchive'),
                  icon: RotateCcw,
                  run: () => onRestore(agent),
                  disabled: pending,
                },
                {
                  label: t('fork'),
                  icon: GitBranch,
                  run: () => onFork(agent),
                  disabled: pending,
                },
                {
                  label: t('deletePermanently'),
                  icon: Trash2,
                  run: () => onDelete(agent),
                  disabled: pending || Boolean(deleteBlockedReason),
                  destructive: true,
                },
              ];
              const name = agent.title || agent.threadId.slice(0, 8);
              return (
                <ContextMenu key={agent.threadId}>
                  <ContextMenuTrigger asChild>
                    <tr className="hover:bg-accent/40">
                      <td className="max-w-80 border-b px-3 py-2">
                        <button
                          type="button"
                          className="cursor-pointer break-words text-left hover:underline"
                          onClick={() => onOpen(agent)}
                        >
                          {name}
                        </button>
                      </td>
                      <td className="max-w-60 border-b px-3 py-2">
                        <span
                          className="block truncate text-muted-foreground"
                          title={agent.workspacePath}
                        >
                          {project.workspaces.find(
                            (workspace) =>
                              workspace.path === agent.workspacePath,
                          )?.name ?? workspaceLabel(agent.workspacePath)}
                        </span>
                      </td>
                      <td className="max-w-64 border-b px-3 py-2">
                        {agent.taskId && agent.taskResourceId ? (
                          <button
                            type="button"
                            className="cursor-pointer break-words text-left hover:underline"
                            onClick={() => onOpenTask(agent)}
                          >
                            {agent.taskTitle ?? agent.taskId}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap border-b px-3 py-2 text-muted-foreground">
                        {agent.archivedAt != null ? (
                          <time
                            dateTime={new Date(agent.archivedAt).toISOString()}
                          >
                            {new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            }).format(agent.archivedAt)}
                          </time>
                        ) : (
                          tw('archiveUnknown')
                        )}
                      </td>
                      <td className="border-b px-3 py-2">
                        {agent.archivedByName ||
                          (agent.archivedByType === 'service'
                            ? tw('archiveService')
                            : agent.archivedByType === 'system'
                              ? tw('archiveSystem')
                              : tw('archiveUnknown'))}
                      </td>
                      <td className="w-10 border-b px-3 py-2">
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              aria-label={`${t('actionsFor')} ${name}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              align="end"
                              sideOffset={4}
                              className="z-50 min-w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
                            >
                              {actions.map(
                                ({
                                  label,
                                  icon: Icon,
                                  run,
                                  disabled,
                                  destructive,
                                }) => (
                                  <DropdownMenu.Item
                                    key={label}
                                    disabled={disabled}
                                    onSelect={run}
                                    title={
                                      destructive
                                        ? (deleteBlockedReason ?? undefined)
                                        : undefined
                                    }
                                    className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50${destructive ? ' text-destructive' : ''}`}
                                  >
                                    <Icon className="h-3.5 w-3.5" />
                                    {label}
                                  </DropdownMenu.Item>
                                ),
                              )}
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </td>
                    </tr>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {actions.map(
                      ({ label, icon: Icon, run, disabled, destructive }) => (
                        <ContextMenuItem
                          key={label}
                          disabled={disabled}
                          onSelect={run}
                          className={
                            destructive ? 'text-destructive' : undefined
                          }
                          title={
                            destructive
                              ? (deleteBlockedReason ?? undefined)
                              : undefined
                          }
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {label}
                        </ContextMenuItem>
                      ),
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </tbody>
        </table>
        {!agents.length && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t('noArchivedThreads')}
          </p>
        )}
      </div>
    </section>
  );
}
