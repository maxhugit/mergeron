/** Overview view: project groups with compact, project-scoped archives. */
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  MessageCircle,
  ListTodo,
  Zap,
  Trash2,
  Package,
  Plus,
  Download,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useDroppable } from '@dnd-kit/react';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { ThreadDto } from '@/generated/api';
import { cn } from '@/lib/utils';
import type { WorkspaceGroup } from './sidebar-types';
import type { ProjectResourceSummary } from '@/lib/projects-api';
import { workspaceLabel } from './sidebar-types';
import { ProjectResourceRow } from './project-resource-row';

const collapseVariants = {
  open: { height: 'auto', opacity: 1 },
  closed: { height: 0, opacity: 0 },
} as const;

function ThreadSkeleton() {
  return (
    <div className="space-y-1.5 pl-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-1.5 px-2 py-1.5">
          <Skeleton className="h-3 w-3 shrink-0 rounded" />
          <Skeleton className="h-3 w-24 rounded" />
        </div>
      ))}
    </div>
  );
}

interface Props {
  projectsHeader: React.ReactNode;
  workspaceGroups: WorkspaceGroup[];
  collapsedGroups: Set<string>;
  isLoading: boolean;
  onToggleCollapse: (key: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenArchivedDetail: (projectId: string) => void;
  onOpenWorkspaceDetail: (cwd: string) => void;
  onCreateAgentInWorkspace: (group: WorkspaceGroup) => void;
  onCreateSimpleChatInWorkspace: (group: WorkspaceGroup) => void;
  onCreateTaskBoard: (group: WorkspaceGroup) => void;
  onCreateAutomationBoard?: (group: WorkspaceGroup) => void;
  onCreateDeliverables?: (group: WorkspaceGroup) => void;
  onOpenResource: (projectId: string, resourceId: string) => void;
  activeResourceId?: string;
  activeProjectId?: string;
  resourceActionPending: boolean;
  onRenameResource: (resource: ProjectResourceSummary) => void;
  onDeleteResource: (resource: ProjectResourceSummary) => void;
  onDeleteProject?: (group: WorkspaceGroup) => void;
  onExportProject?: (group: WorkspaceGroup) => void;
  renderThreadRow: (
    thread: ThreadDto,
    archived: boolean,
    projectId?: string,
  ) => React.ReactNode;
  renderSimpleChatRow: (
    thread: WorkspaceGroup['simpleChats'][number],
  ) => React.ReactNode;
  movingThread: boolean;
}

export function WorkspaceOverview({
  projectsHeader,
  workspaceGroups,
  collapsedGroups,
  isLoading,
  onToggleCollapse,
  onOpenProject,
  onOpenArchivedDetail,
  onOpenWorkspaceDetail,
  onCreateAgentInWorkspace,
  onCreateSimpleChatInWorkspace,
  onCreateTaskBoard,
  onCreateAutomationBoard,
  onCreateDeliverables,
  onOpenResource,
  activeResourceId,
  activeProjectId,
  resourceActionPending,
  onRenameResource,
  onDeleteResource,
  onDeleteProject,
  onExportProject,
  renderThreadRow,
  renderSimpleChatRow,
  movingThread,
}: Props) {
  const { t } = useTranslation(['common', 'projectArchives'], {
    nsMode: 'fallback',
  });
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-4 pb-2 pt-1">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center gap-1.5 px-2">
              <Skeleton className="h-3.5 w-3.5 rounded" />
              <Skeleton className="h-4 w-20 rounded" />
            </div>
            <ThreadSkeleton />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-2">
      {projectsHeader}

      {/* Workspace groups */}
      {workspaceGroups.map((group) => {
        const collapsed = collapsedGroups.has(group.cwd);
        const orderedItems = orderSidebarItems(group);
        return (
          <WorkspaceDropTarget
            key={group.cwd}
            cwd={group.cwd}
            projectId={group.projectId}
            disabled={movingThread}
          >
            <div
              className={cn(
                'mb-0.5 flex items-center gap-1 rounded-lg px-2',
                group.projectId === activeProjectId && 'bg-accent',
              )}
              title={group.cwd}
              onContextMenu={(event) => {
                event.preventDefault();
                setOpenMenu(group.cwd);
              }}
            >
              <button
                type="button"
                className="flex h-7 shrink-0 cursor-pointer items-center text-muted-foreground hover:text-foreground"
                onClick={() => onToggleCollapse(group.cwd)}
                aria-label={
                  collapsed ? t('expandProject') : t('collapseProject')
                }
              >
                {collapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform" />
                )}
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-sm font-medium text-foreground/80 hover:text-foreground"
                onClick={() =>
                  group.projectId
                    ? onOpenProject(group.projectId)
                    : onToggleCollapse(group.cwd)
                }
              >
                <span className="truncate">
                  {group.name ?? workspaceLabel(group.cwd)}
                </span>
                {(group.workspaces?.length ?? 0) > 1 && (
                  <span className="shrink-0 rounded bg-muted px-1 text-[9px] font-normal text-muted-foreground">
                    {group.workspaces?.length} {t('workspaces')}
                  </span>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-0.5">
                <Popover
                  open={openMenu === group.cwd}
                  onOpenChange={(open) => setOpenMenu(open ? group.cwd : null)}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      aria-label={t('projectActions')}
                      title={t('projectActions')}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-56 p-1">
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start gap-2 px-2 text-xs"
                      onClick={() => {
                        setOpenMenu(null);
                        onCreateAgentInWorkspace(group);
                      }}
                    >
                      <Bot className="h-3.5 w-3.5" />
                      {t('workAgent')}
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start gap-2 px-2 text-xs"
                      onClick={() => {
                        setOpenMenu(null);
                        onCreateSimpleChatInWorkspace(group);
                      }}
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                      {t('simpleConversation')}
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start gap-2 px-2 text-xs"
                      onClick={() => {
                        setOpenMenu(null);
                        onCreateTaskBoard(group);
                      }}
                    >
                      <ListTodo className="h-3.5 w-3.5" />
                      {t('taskManager')}
                    </Button>
                    {onCreateAutomationBoard && (
                      <Button
                        variant="ghost"
                        className="h-8 w-full justify-start gap-2 px-2 text-xs"
                        onClick={() => {
                          setOpenMenu(null);
                          const existing = group.resources?.find(
                            (r) => r.type === 'automation_board',
                          );
                          if (existing && group.projectId)
                            onOpenResource(group.projectId, existing.id);
                          else onCreateAutomationBoard(group);
                        }}
                      >
                        <Zap className="h-3.5 w-3.5" />
                        {t('automations')}
                      </Button>
                    )}
                    {onCreateDeliverables && (
                      <Button
                        variant="ghost"
                        className="h-8 w-full justify-start gap-2 px-2 text-xs"
                        onClick={() => {
                          setOpenMenu(null);
                          const existing = group.resources?.find(
                            (r) => r.type === 'deliverable_board',
                          );
                          if (existing && group.projectId)
                            onOpenResource(group.projectId, existing.id);
                          else onCreateDeliverables(group);
                        }}
                      >
                        <Package className="h-3.5 w-3.5" />
                        {t('deliverablesManagement')}
                      </Button>
                    )}
                    {onExportProject && group.projectId && (
                      <Button
                        variant="ghost"
                        className="h-8 w-full justify-start gap-2 px-2 text-xs"
                        onClick={() => {
                          setOpenMenu(null);
                          onExportProject(group);
                        }}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t('projectArchiveExport')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start gap-2 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={() => {
                        setOpenMenu(null);
                        onDeleteProject?.(group);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('deleteProject')}
                    </Button>
                  </PopoverContent>
                </Popover>
                {group.threads.length + group.simpleChats.length >= 5 && (
                  <button
                    type="button"
                    className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    onClick={() => onOpenWorkspaceDetail(group.cwd)}
                    aria-label={t('viewMore')}
                    title={t('viewMore')}
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.div
                  key={`ws-${group.cwd}`}
                  initial="closed"
                  animate="open"
                  exit="closed"
                  variants={collapseVariants}
                  transition={{ duration: 0.15, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="space-y-0.5">
                    {orderedItems.map((item) => (
                      <SidebarItemDropTarget
                        key={item.key}
                        itemId={item.key}
                        projectId={group.projectId}
                        disabled={movingThread}
                      >
                        {item.kind === 'resource' ? (
                          <ProjectResourceRow
                            resource={item.resource}
                            active={item.resource.id === activeResourceId}
                            pending={resourceActionPending}
                            onOpen={() =>
                              group.projectId &&
                              onOpenResource(group.projectId, item.resource.id)
                            }
                            onRename={() => onRenameResource(item.resource)}
                            onDelete={() => onDeleteResource(item.resource)}
                          />
                        ) : item.kind === 'agent' ? (
                          renderThreadRow(item.thread, false, group.projectId)
                        ) : (
                          renderSimpleChatRow(item.thread)
                        )}
                      </SidebarItemDropTarget>
                    ))}
                    {group.projectId &&
                      Boolean(group.archivedAgents?.length) && (
                        <button
                          type="button"
                          className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                          onClick={() => onOpenArchivedDetail(group.projectId!)}
                        >
                          <Archive className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {t('archivedAgents')}
                          </span>
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                            {group.archivedAgents?.length}
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                        </button>
                      )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </WorkspaceDropTarget>
        );
      })}

      {workspaceGroups.length === 0 && (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">
          {t('noThreadsYet')}
        </p>
      )}
    </div>
  );
}

type SidebarItem =
  | { kind: 'resource'; key: string; resource: ProjectResourceSummary }
  | { kind: 'agent'; key: string; thread: ThreadDto }
  | {
      kind: 'simple';
      key: string;
      thread: WorkspaceGroup['simpleChats'][number];
    };

function orderSidebarItems(group: WorkspaceGroup): SidebarItem[] {
  const items: SidebarItem[] = [
    ...(group.resources ?? []).map(
      (resource): SidebarItem => ({
        kind: 'resource',
        key: `resource:${resource.id}`,
        resource,
      }),
    ),
    ...group.threads.map(
      (thread): SidebarItem => ({
        kind: 'agent',
        key: `agent:${thread.id}`,
        thread,
      }),
    ),
    ...group.simpleChats.map(
      (thread): SidebarItem => ({
        kind: 'simple',
        key: `simple:${thread.id}`,
        thread,
      }),
    ),
  ];
  const rank = new Map(
    (group.sidebarOrder ?? []).map((key, index) => [key, index]),
  );
  items.sort(
    (a, b) =>
      (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER),
  );
  let visibleConversations = 0;
  return items.filter((item) => {
    if (item.kind === 'resource') return true;
    visibleConversations += 1;
    return visibleConversations <= 5;
  });
}

function SidebarItemDropTarget({
  itemId,
  projectId,
  disabled,
  children,
}: {
  itemId: string;
  projectId?: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `sidebar-item-${projectId}-${itemId}`,
    disabled: disabled || !projectId,
    data: { kind: 'sidebar-item', projectId, sidebarItemId: itemId },
  });
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-md transition-colors',
        isDropTarget && 'bg-primary/10 ring-1 ring-primary/30',
      )}
    >
      {children}
    </div>
  );
}

function WorkspaceDropTarget({
  cwd,
  projectId,
  disabled,
  children,
}: {
  cwd: string;
  projectId?: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `workspace-${cwd}`,
    disabled,
    data: { kind: 'workspace', cwd, projectId },
  });
  return (
    <section
      ref={ref}
      className={cn(
        'rounded-md transition-colors',
        isDropTarget && 'bg-primary/10 ring-1 ring-primary/30',
      )}
    >
      {children}
    </section>
  );
}
